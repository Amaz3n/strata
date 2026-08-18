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
  error: { message: string } | null
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
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    for (const row of batch) rows.push(row)
    // A short page is the end of the source. A full last page that lands exactly
    // on the cap reports truncated — over-reporting is the safe direction.
    if (batch.length < size) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}
