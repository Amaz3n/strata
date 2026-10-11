/**
 * Reading a whole set out of PostgREST.
 *
 * Every PostgREST response is capped, so a bare `.limit(5_000)` on a table that
 * grows with the business is a silent truncation waiting for the first org that
 * outgrows it — and a total tallied from a truncated page is not a smaller
 * number, it is a wrong one. A 400-lot community and a 200-active-project org
 * are the design case here, not the stress case.
 *
 * `readAllRows` pages until the source is exhausted and reports `truncated` when
 * a hard ceiling stopped it first, so a caller can always tell "that is all of
 * it" from "that is as far as I got" and say so on screen.
 *
 * Pure plumbing — it takes a range function rather than a query builder, so it
 * carries no Supabase types and stays testable without a database.
 */

/** PostgREST's own default page. Bigger pages buy little and cost memory. */
export const READ_PAGE_SIZE = 1_000

export interface PagedRows<Row> {
  rows: Row[]
  /** True when `cap` stopped the read before the source ran out. */
  truncated: boolean
}

export interface RangeResult<Row> {
  data: Row[] | null
  error: { message: string; code?: string } | null
  count?: number | null
}

/** PostgREST answers 416 / PGRST103 when a range starts past the last row. */
const RANGE_PAST_END = "PGRST103"

export function isRangePastEnd(error: { code?: string } | null | undefined): boolean {
  return error?.code === RANGE_PAST_END
}

/**
 * One page of a counted read. A page past the last row is an empty page, not a
 * failure: a reader sitting on the last page when rows are removed, or a stale
 * "show more", must see nothing rather than an error. The total is still true,
 * read with a one-row range.
 */
export async function readPageOrEmpty<Row>(
  read: (from: number, to: number) => PromiseLike<RangeResult<Row>>,
  from: number,
  to: number,
): Promise<{ data: Row[]; count: number | null; error: { message: string; code?: string } | null }> {
  const first = await read(from, to)
  if (!isRangePastEnd(first.error)) return { data: first.data ?? [], count: first.count ?? null, error: first.error }
  const head = await read(0, 0)
  return { data: [], count: head.count ?? null, error: head.error }
}

/** `(from, to)` are inclusive row offsets, exactly as `PostgrestBuilder.range` takes them. */
export type RangeReader<Row> = (from: number, to: number) => PromiseLike<RangeResult<Row>>

export async function readAllRows<Row>(
  read: RangeReader<Row>,
  { cap, label, pageSize = READ_PAGE_SIZE }: { cap: number; label: string; pageSize?: number },
): Promise<PagedRows<Row>> {
  const rows: Row[] = []
  for (let from = 0; from < cap; from += pageSize) {
    const size = Math.min(pageSize, cap - from)
    const { data, error } = await read(from, from + size - 1)
    // A full page that ended exactly on the last row leaves the next range past the end.
    if (isRangePastEnd(error)) return { rows, truncated: false }
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    for (const row of batch) rows.push(row)
    // A short page is the end of the source. A full last page that lands exactly
    // on the cap reports truncated — over-reporting is the safe direction.
    if (batch.length < size) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

/**
 * Exhaust an ID-ordered UUID query. Only an empty page proves exhaustion:
 * a provider may return fewer rows than requested because of its own row cap.
 * Callers must reapply organization/actor/scope predicates on every page.
 */
export async function readAllRowsById<Row extends { id: string }>(
  read: (afterId: string | null, limit: number) => PromiseLike<RangeResult<Row>>,
  { cap, label, pageSize = 100 }: { cap: number; label: string; pageSize?: number },
): Promise<Row[]> {
  if (!Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error(`${label}: Invalid paging bounds`)
  const rows: Row[] = []
  let afterId: string | null = null
  while (true) {
    const take = Math.min(pageSize, cap - rows.length + 1)
    const { data, error } = await read(afterId, take)
    if (error || !Array.isArray(data) || data.length > take) throw new Error(`${label}: ${error?.message ?? "Invalid page response"}`)
    if (!data.length) return rows
    for (const row of data) {
      if (typeof row.id !== "string" || !row.id || (afterId !== null && row.id <= afterId)) throw new Error(`${label}: ID cursor did not advance`)
      rows.push(row)
      afterId = row.id
      if (rows.length > cap) throw new Error(`${label}: Validation limit exceeded (${cap} rows)`)
    }
  }
}
