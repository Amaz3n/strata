import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { compareHomeFigures, type HomeComparison, type HomeFigures } from "@/lib/cutover/records"
import { readAllRows } from "@/lib/land/paging"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { reconcileInstalledWarrantyHomes, type WarrantyCoverageReconciliation } from "@/lib/services/warranty-installed-base"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { chunks } from "@/lib/services/cutover/homes"

/** Rows one section reads; past it the report says it is partial rather than reconcile a part as the whole. */
const SECTION_CAP = 20_000
const MISMATCHES_SHOWN = 200

interface Scope { supabase: SupabaseClient; orgId: string; divisionIds: string[] | null }

export interface CutoverSection {
  homes: number
  matched: number
  sourceTotals: HomeFigures
  arcTotals: HomeFigures
  mismatchCount: number
  mismatches: Array<HomeComparison & { home: string }>
  truncated: boolean
}

export interface CutoverReconciliation {
  /** `unlinkedOpeningDeposits` is null for a division-scoped viewer: a deposit on no home is in no division. */
  agreements: (CutoverSection & { imported: number; executed: number; accepted: number; evidenceMissing: number; unlinkedOpeningDeposits: number | null }) | null
  selections: CutoverSection | null
  inspections: CutoverSection | null
  warranty: Pick<WarrantyCoverageReconciliation, "homes" | "covered" | "active" | "expired" | "exceptionCount" | "clean"> | null
}

async function readPaged<Row>(label: string, schema: z.ZodType<Row>, read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>) {
  const result = await readAllRows(read, { cap: SECTION_CAP, label })
  return { rows: z.array(schema).parse(result.rows), truncated: result.truncated }
}

async function readIn<Row>(label: string, ids: readonly string[], schema: z.ZodType<Row>, read: (group: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const results = await Promise.all(chunks(ids).map((group) => read(group)))
  return results.flatMap((result) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return z.array(schema).parse(result.data ?? []) })
}

const projectSchema = z.object({ id: z.string().uuid(), name: z.string(), division_id: z.string().uuid().nullable() })

/** The homes among these the viewer's divisions reach, by name. */
async function visibleHomes(scope: Scope, projectIds: readonly string[]) {
  const projects = await readIn("Failed to read homes", [...new Set(projectIds)], projectSchema, (group) => scope.supabase.from("projects").select("id,name,division_id").eq("org_id", scope.orgId).in("id", group))
  return new Map(projects.filter((project) => !scope.divisionIds || (project.division_id !== null && scope.divisionIds.includes(project.division_id))).map((project) => [project.id, project.name]))
}

/** Keeps the homes the viewer's divisions reach, then names the mismatched ones. */
async function finish(scope: Scope, keys: readonly string[], source: Map<string, HomeFigures>, arc: Map<string, HomeFigures>, truncated: boolean): Promise<CutoverSection> {
  const visible = await visibleHomes(scope, [...source.keys()])
  const scoped = new Map([...source].filter(([projectId]) => visible.has(projectId)))
  const result = compareHomeFigures(keys, scoped, arc)
  return {
    homes: result.homes, matched: result.matched, sourceTotals: result.sourceTotals, arcTotals: result.arcTotals, truncated,
    mismatchCount: result.mismatches.length,
    mismatches: result.mismatches.slice(0, MISMATCHES_SHOWN).map((item) => ({ ...item, home: visible.get(item.projectId) ?? item.projectId })),
  }
}

/** Committed rows of one importer (and file kind) that landed on a home, oldest batch first. */
async function sourceRows(scope: Scope, importer: string, fileKind: string | null) {
  const batchRows = await readPaged("Failed to read committed imports", z.object({ id: z.string().uuid(), committed_at: z.string().nullable() }), (from, to) => {
    const query = scope.supabase.from("import_batches").select("id,committed_at").eq("org_id", scope.orgId).eq("importer", importer).eq("status", "committed")
    return (fileKind ? query.eq("context->>file_kind", fileKind) : query).order("committed_at").order("id").range(from, to)
  })
  const order = new Map(batchRows.rows.map((batch, index) => [batch.id, index]))
  const rows: Array<{ batch_id: string; natural_key: string; target_entity_id: string; parsed: Record<string, unknown> }> = []
  let truncated = batchRows.truncated
  for (const group of chunks(batchRows.rows.map((batch) => batch.id), 50)) {
    const page = await readPaged("Failed to read committed import rows", z.object({ batch_id: z.string().uuid(), natural_key: z.string(), target_entity_id: z.string().uuid(), parsed: z.record(z.unknown()) }),
      (from, to) => scope.supabase.from("import_rows").select("batch_id,natural_key,target_entity_id,parsed").eq("org_id", scope.orgId).in("batch_id", group).in("status", ["committed", "skipped"]).not("target_entity_id", "is", null).order("id").range(from, to))
    rows.push(...page.rows)
    truncated ||= page.truncated
  }
  rows.sort((a, b) => (order.get(a.batch_id) ?? 0) - (order.get(b.batch_id) ?? 0))
  return { rows, truncated }
}

const evidenceRowSchema = z.object({ project_id: z.string().uuid(), status: z.string(), source_deposit_cents: z.number().int().nullable(), contract: z.object({ status: z.string() }) })
const depositSchema = z.object({ project_id: z.string().uuid().nullable(), total_cents: z.number().int().nullable(), balance_due_cents: z.number().int().nullable() })

/** Imported agreements by evidence state, and each home's deposits as the source states them against what Arc holds. */
async function agreementsSection(scope: Scope): Promise<NonNullable<CutoverReconciliation["agreements"]>> {
  const [read, unlinked] = await Promise.all([
    readPaged("Failed to read imported agreements", evidenceRowSchema, (from, to) => scope.supabase.from("imported_agreement_evidence").select("project_id,status,source_deposit_cents,contract:contracts!inner(status)").eq("org_id", scope.orgId).eq("contract.status", "active").order("id").range(from, to)),
    scope.divisionIds ? null : scope.supabase.from("invoices").select("id", { count: "exact", head: true }).eq("org_id", scope.orgId).is("project_id", null).eq("metadata->>invoice_kind", "earnest_deposit").not("metadata->>opening_batch_id", "is", null),
  ])
  if (unlinked?.error) throw new Error(`Failed to count opening deposits: ${unlinked.error.message}`)
  const visible = scope.divisionIds ? await visibleHomes(scope, read.rows.map((row) => row.project_id)) : null
  const evidence = { truncated: read.truncated, rows: visible ? read.rows.filter((row) => visible.has(row.project_id)) : read.rows }
  const stated = evidence.rows.filter((row) => row.source_deposit_cents !== null)
  const source = new Map(stated.map((row) => [row.project_id, { deposits_cents: row.source_deposit_cents ?? 0 }]))
  const deposits = await readIn("Failed to read deposits", [...source.keys()], depositSchema, (group) => scope.supabase.from("invoices").select("project_id,total_cents,balance_due_cents")
    .eq("org_id", scope.orgId).eq("metadata->>invoice_kind", "earnest_deposit").not("status", "in", "(void,draft)").in("project_id", group))
  const arc = new Map<string, HomeFigures>()
  for (const invoice of deposits) {
    if (!invoice.project_id) continue
    const received = (invoice.total_cents ?? 0) - (invoice.balance_due_cents ?? 0)
    arc.set(invoice.project_id, { deposits_cents: (arc.get(invoice.project_id)?.deposits_cents ?? 0) + received })
  }
  const section = await finish(scope, ["deposits_cents"], source, arc, evidence.truncated)
  const count = (status: string) => evidence.rows.filter((row) => row.status === status).length
  return { ...section, imported: evidence.rows.length, executed: count("executed_file"), accepted: count("accepted"), evidenceMissing: count("evidence_missing"), unlinkedOpeningDeposits: unlinked ? unlinked.count ?? 0 : null }
}

const selectionFigureSchema = z.object({ project_id: z.string().uuid(), price_cents_snapshot: z.number().int().nullable() })
const orderSchema = z.object({ project_id: z.string().uuid(), total_cents: z.number().int().nullable() })

/** Each home's selections count and total and change-order balance, as the latest home-totals file states them, against Arc. */
async function selectionsSection(scope: Scope): Promise<CutoverSection> {
  const { rows, truncated } = await sourceRows(scope, "selections", "totals")
  const source = new Map<string, HomeFigures>()
  for (const row of rows) source.set(row.target_entity_id, { selections: Number(row.parsed.selection_count ?? 0), selections_total_cents: Number(row.parsed.selections_total_cents ?? 0), change_order_balance_cents: Number(row.parsed.change_order_balance_cents ?? 0) })
  const ids = [...source.keys()]
  const [selections, orders] = await Promise.all([
    readIn("Failed to read selections", ids, selectionFigureSchema, (group) => scope.supabase.from("project_selections").select("project_id,price_cents_snapshot").eq("org_id", scope.orgId).not("selected_option_id", "is", null).in("project_id", group)),
    readIn("Failed to read change orders", ids, orderSchema, (group) => scope.supabase.from("change_orders").select("project_id,total_cents").eq("org_id", scope.orgId).eq("status", "approved").not("metadata->imported_cutover_balance", "is", null).in("project_id", group)),
  ])
  const arc = new Map<string, HomeFigures>()
  const bump = (projectId: string, key: string, by: number) => { const figures = arc.get(projectId) ?? {}; figures[key] = (figures[key] ?? 0) + by; arc.set(projectId, figures) }
  for (const selection of selections) { bump(selection.project_id, "selections", 1); bump(selection.project_id, "selections_total_cents", selection.price_cents_snapshot ?? 0) }
  for (const order of orders) bump(order.project_id, "change_order_balance_cents", order.total_cents ?? 0)
  return finish(scope, ["selections", "selections_total_cents", "change_order_balance_cents"], source, arc, truncated)
}

/** Each home's past inspections as the source files list them, against the history records Arc holds. */
async function inspectionsSection(scope: Scope): Promise<CutoverSection> {
  const { rows, truncated } = await sourceRows(scope, "inspection_history", null)
  const keys = new Map<string, Set<string>>()
  for (const row of rows) keys.set(row.target_entity_id, (keys.get(row.target_entity_id) ?? new Set()).add(row.natural_key))
  const source = new Map([...keys].map(([projectId, set]) => [projectId, { inspections: set.size }]))
  const records = await readIn("Failed to read inspection history", [...source.keys()], z.object({ project_id: z.string().uuid() }), (group) => scope.supabase.from("imported_inspection_records").select("project_id").eq("org_id", scope.orgId).in("project_id", group))
  const arc = new Map<string, HomeFigures>()
  for (const record of records) arc.set(record.project_id, { inspections: (arc.get(record.project_id)?.inspections ?? 0) + 1 })
  return finish(scope, ["inspections"], source, arc, truncated)
}

/**
 * The cutover reconciliation: what the source systems state against what Arc
 * holds, for every cutover record the viewer may see. A section the viewer's
 * permissions do not reach is null, not empty.
 */
export async function getCutoverReconciliation(): Promise<CutoverReconciliation> {
  const context = await requireOrgContext()
  const [{ permissions }, access] = await Promise.all([getCurrentUserPermissions(), getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })])
  const granted = new Set(permissions)
  const may = (key: string) => granted.has("*") || granted.has(key)
  const scope: Scope = { supabase: createServiceSupabaseClient(), orgId: context.orgId, divisionIds: access.assignedOnly ? access.divisionIds : null }
  const [agreements, selections, inspections, warranty] = await Promise.all([
    may("closing.manage") ? agreementsSection(scope) : null,
    may("design_studio.manage") ? selectionsSection(scope) : null,
    may("inspection.write") ? inspectionsSection(scope) : null,
    may("warranty.manage") ? reconcileInstalledWarrantyHomes({ supabase: scope.supabase, orgId: context.orgId, userId: context.userId }) : null,
  ])
  return {
    agreements, selections, inspections,
    warranty: warranty ? { homes: warranty.homes, covered: warranty.covered, active: warranty.active, expired: warranty.expired, exceptionCount: warranty.exceptionCount, clean: warranty.clean } : null,
  }
}
