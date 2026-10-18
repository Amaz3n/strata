import "server-only"
import { z } from "zod"
import { normalizeInspectionResult } from "@/lib/cutover/records"
import { normalizeKey } from "@/lib/services/import-parsers"
import { requirePermission } from "@/lib/services/permissions"
import { chunks, freshCopies, refuseChangedRows, resolveCutoverHomes, settleRow, todayUtc, type CutoverImportContext, type CutoverStagedRow } from "@/lib/services/cutover/homes"

const recordSchema = z.object({ project_id: z.string().uuid(), inspection_type: z.string(), inspected_on: z.string(), result: z.string() })

const identity = (projectId: string, type: unknown, on: unknown, result: unknown) => `${projectId}|${normalizeKey(type)}|${String(on)}|${String(result)}`

/**
 * The cutover rule for inspections: every past inspection on an open home comes
 * over as it stands in the source (type, date, result) as a read-only history
 * record. A record never becomes an inspection, attempt, obligation or closing
 * gate, so every new inspection, a reinspection of a type that failed before
 * cutover included, starts in the inspection lifecycle.
 */
export async function validateInspectionHistoryRows<Row extends CutoverStagedRow>(rows: Row[], context: CutoverImportContext): Promise<Row[]> {
  const homes = await resolveCutoverHomes(rows, context)
  const projectIds = [...new Set([...homes.values()].map((home) => home.projectId))]
  const results = await Promise.all(chunks(projectIds).map((group) => context.supabase.from("imported_inspection_records").select("project_id,inspection_type,inspected_on,result").eq("org_id", context.orgId).in("project_id", group)))
  const existing = new Set(results.flatMap((result) => { if (result.error) throw new Error(`Failed to read inspection history: ${result.error.message}`); return z.array(recordSchema).parse(result.data ?? []) })
    .map((record) => identity(record.project_id, record.inspection_type, record.inspected_on, record.result)))
  for (const row of rows) {
    const home = homes.get(row.id)
    if (!home) { settleRow(row); continue }
    const parsed = row.parsed
    const result = normalizeInspectionResult(parsed.result)
    if (!result) row.issues.push({ level: "error", code: "invalid_result", message: "Result must be pass, fail or partial", column: "result" })
    else parsed.result = result
    if (typeof parsed.inspected_on === "string" && parsed.inspected_on > todayUtc()) row.issues.push({ level: "error", code: "inspected_in_future", message: "A past inspection cannot be dated in the future", column: "inspected_on" })
    if (result && existing.has(identity(home.projectId, parsed.inspection_type, parsed.inspected_on, result))) row.issues.push({ level: "warning", code: "already_imported", message: "This inspection is already in the home's history; it is matched and left as it is" })
    settleRow(row)
  }
  return rows
}

export async function commitInspectionHistoryRows(rows: CutoverStagedRow[], context: CutoverImportContext, batchId: string) {
  if (!context.platform) await requirePermission("inspection.write", context)
  const rechecked = await validateInspectionHistoryRows(freshCopies(rows), context)
  refuseChangedRows(rechecked)
  const results = new Map<string, { id: string; action: string }>()
  const fresh = rechecked.filter((row) => !row.issues.some((issue) => issue.code === "already_imported"))
  for (const row of rechecked) if (!fresh.includes(row)) results.set(row.id, { id: String(row.parsed.project_id), action: "skipped_existing" })
  for (const group of chunks(fresh)) {
    const { error } = await context.supabase.from("imported_inspection_records").insert(group.map((row) => ({
      org_id: context.orgId, project_id: String(row.parsed.project_id), inspection_type: String(row.parsed.inspection_type).trim(), inspected_on: String(row.parsed.inspected_on),
      result: String(row.parsed.result), inspector: typeof row.parsed.inspector === "string" ? row.parsed.inspector : null, reference: typeof row.parsed.reference === "string" ? row.parsed.reference : null,
      source_batch_id: batchId, source_row_id: row.id, created_by: context.userId,
    })))
    if (error) throw new Error(`Failed to record inspection history: ${error.message}`)
    for (const row of group) results.set(row.id, { id: String(row.parsed.project_id), action: "created" })
  }
  return results
}
