import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readAllRows } from "@/lib/land/paging"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { agreementWriteAllowed } from "@/lib/services/price-book"
import { normalizeKey, type ImportIssue, type ImportParsedRow } from "@/lib/services/import-parsers"

/** What the importer hands a cutover-record module: the service client, already authorized. */
export interface CutoverImportContext { supabase: SupabaseClient; orgId: string; userId: string; platform: boolean }
export interface CutoverStagedRow { id: string; row_number: number; parsed: ImportParsedRow; issues: ImportIssue[]; status: string }

export interface CutoverHome { communityId: string; lotId: string; projectId: string; closed: boolean }

const CHUNK = 200
/** Lots read per community set; past it the import refuses rather than miss a lot. */
const LOT_CAP = 20_000

export function chunks<T>(items: readonly T[], size = CHUNK) {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

export function settleRow(row: CutoverStagedRow) {
  if (row.status === "skipped") return
  row.status = row.issues.some((issue) => issue.level === "error") ? "error" : row.issues.some((issue) => issue.level === "warning") ? "warning" : "valid"
}

export function hasError(row: CutoverStagedRow) {
  return row.issues.some((issue) => issue.level === "error")
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

function lotKey(communityId: string, lotNumber: unknown, block: unknown) {
  return `${communityId}|${normalizeKey(lotNumber)}|${normalizeKey(block)}`
}

const communitySchema = z.object({ id: z.string().uuid(), division_id: z.string().uuid().nullable() })
const lotSchema = z.object({ id: z.string().uuid(), community_id: z.string().uuid(), lot_number: z.string(), block: z.string().nullable(), project_id: z.string().uuid().nullable() })

/**
 * The home on each row's lot. A row whose community is outside the member's
 * divisions, whose lot is unknown or bare, or (unless `allowClosed`) whose home
 * has already closed gets the matching error. Rows without a resolved community
 * already carry the importer's own error and are left alone.
 */
export async function resolveCutoverHomes<Row extends CutoverStagedRow>(rows: Row[], context: CutoverImportContext, options: { allowClosed?: boolean } = {}) {
  const live = rows.filter((row) => row.status !== "skipped")
  const communityIds = [...new Set(live.flatMap((row) => (typeof row.parsed.community_id === "string" ? [row.parsed.community_id] : [])))]
  const [access, communities, lots] = await Promise.all([
    context.platform ? Promise.resolve({ assignedOnly: false, divisionIds: [] as string[] }) : getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
    Promise.all(chunks(communityIds).map((ids) => context.supabase.from("communities").select("id,division_id").eq("org_id", context.orgId).in("id", ids)))
      .then((results) => results.flatMap((result) => { if (result.error) throw new Error(`Failed to read communities: ${result.error.message}`); return z.array(communitySchema).parse(result.data) })),
    Promise.all(chunks(communityIds).map(async (ids) => {
      const result = await readAllRows((from, to) => context.supabase.from("lots").select("id,community_id,lot_number,block,project_id").eq("org_id", context.orgId).in("community_id", ids).order("id").range(from, to), { cap: LOT_CAP, label: "Failed to read lots" })
      if (result.truncated) throw new Error(`More than ${LOT_CAP} lots in these communities; import them in smaller sets`)
      return z.array(lotSchema).parse(result.rows)
    })).then((pages) => pages.flat()),
  ])
  const communityById = new Map(communities.map((community) => [community.id, community]))
  const lotByKey = new Map(lots.map((lot) => [lotKey(lot.community_id, lot.lot_number, lot.block), lot]))
  const projectIds = [...new Set(lots.flatMap((lot) => (lot.project_id ? [lot.project_id] : [])))]
  const closedResults = await Promise.all(chunks(projectIds).map((ids) => context.supabase.from("closings").select("project_id").eq("org_id", context.orgId).eq("status", "closed").in("project_id", ids)))
  const closed = new Set(closedResults.flatMap((result) => { if (result.error) throw new Error(`Failed to read closings: ${result.error.message}`); return z.array(z.object({ project_id: z.string().uuid() })).parse(result.data).map((row) => row.project_id) }))

  const homes = new Map<string, CutoverHome>()
  for (const row of live) {
    const community = typeof row.parsed.community_id === "string" ? communityById.get(row.parsed.community_id) : undefined
    if (!community) continue
    if (!agreementWriteAllowed(access, { divisionId: null, communityId: community.id, communityDivisionId: community.division_id })) {
      row.issues.push({ level: "error", code: "outside_division", message: "This community is outside your divisions", column: "community" })
      continue
    }
    const lot = lotByKey.get(lotKey(community.id, row.parsed.lot_number, row.parsed.block))
    if (!lot) { row.issues.push({ level: "error", code: "unresolved_lot", message: "This lot was not found in the community", column: "lot_number" }); continue }
    if (!lot.project_id) { row.issues.push({ level: "error", code: "no_home", message: "No home stands on this lot in Arc; bring it over with Open WIP first", column: "lot_number" }); continue }
    const home = { communityId: community.id, lotId: lot.id, projectId: lot.project_id, closed: closed.has(lot.project_id) }
    if (home.closed && !options.allowClosed) { row.issues.push({ level: "error", code: "home_closed", message: "This home has closed; only open homes take cutover records", column: "lot_number" }); continue }
    row.parsed.project_id = home.projectId
    homes.set(row.id, home)
  }
  return homes
}

/**
 * Commit re-runs staging's checks on a copy of the rows: a lot, division or
 * record that changed since staging refuses the whole batch before any write.
 */
export function refuseChangedRows(rows: CutoverStagedRow[]) {
  const failed = rows.filter(hasError)
  if (failed.length === 0) return
  const sample = failed.slice(0, 5).map((row) => `row ${row.row_number}: ${row.issues.find((issue) => issue.level === "error")?.message ?? "error"}`)
  throw new Error(`Rows changed since staging (${sample.join("; ")}). Nothing was imported; stage the file again.`)
}

/** Copies of committed rows with their staging issues cleared, for the commit-time recheck. */
export function freshCopies<Row extends CutoverStagedRow>(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row, parsed: { ...row.parsed }, issues: [], status: "pending" }))
}
