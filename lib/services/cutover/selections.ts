import "server-only"
import { z } from "zod"
import { normalizeSelectionStatus, selectionLocksAtImport } from "@/lib/cutover/records"
import { normalizeKey } from "@/lib/services/import-parsers"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { instantiateSelectionGroupsForProject } from "@/lib/services/selection-cutoffs"
import { chunks, freshCopies, refuseChangedRows, resolveCutoverHomes, settleRow, todayUtc, type CutoverImportContext, type CutoverStagedRow } from "@/lib/services/cutover/homes"

const optionSchema = z.object({ id: z.string().uuid(), sku: z.string().nullable(), category_id: z.string().uuid(), community_id: z.string().uuid().nullable(), price_cents: z.number().int().nullable(), cost_cents: z.number().int().nullable() })
const selectionSchema = z.object({ project_id: z.string().uuid(), category_id: z.string().uuid(), selected_option_id: z.string().uuid().nullable(), price_cents_snapshot: z.number().int().nullable(), metadata: z.record(z.unknown()).nullable() })
const groupSchema = z.object({ id: z.string().uuid(), name: z.string(), community_id: z.string().uuid().nullable() })
const projectGroupSchema = z.object({ project_id: z.string().uuid(), group_id: z.string().uuid(), cutoff_date: z.string().nullable(), cutoff_source: z.string(), metadata: z.record(z.unknown()).nullable() })
const balanceOrderSchema = z.object({ project_id: z.string().uuid(), total_cents: z.number().int().nullable() })
const contractSchema = z.object({ id: z.string().uuid(), project_id: z.string().uuid() })

async function readIn<Row>(label: string, ids: readonly string[], read: (group: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>, schema: z.ZodType<Row>) {
  const results = await Promise.all(chunks(ids).map((group) => read(group)))
  return results.flatMap((result) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return z.array(schema).parse(result.data ?? []) })
}

function fileKindOf(context: Record<string, unknown>) {
  const kind = context.file_kind
  return kind === "cutoffs" || kind === "totals" ? kind : "selections"
}

/** The imported balance amendment on a home, if one exists: the single change order this importer writes per home. */
const IMPORTED_BALANCE_KEY = "imported_cutover_balance"
const UNIQUE_VIOLATION = "23505"

/**
 * Staging checks for a "Selections & cutoffs" file of one kind. Selections name
 * the option by code and carry the price the buyer was given; a choice Arc
 * already holds for that category is kept, never overwritten. Cutoffs name the
 * community's selection group. Home totals are the source's control figures the
 * reconciliation compares against, and a change-order balance amends the home's
 * agreement once.
 */
export async function validateSelectionRows<Row extends CutoverStagedRow>(rows: Row[], context: CutoverImportContext, batchContext: Record<string, unknown>): Promise<Row[]> {
  const kind = fileKindOf(batchContext)
  const homes = await resolveCutoverHomes(rows, context)
  const projectIds = [...new Set([...homes.values()].map((home) => home.projectId))]
  const communityIds = [...new Set([...homes.values()].map((home) => home.communityId))]

  if (kind === "selections") {
    const skus = [...new Set(rows.flatMap((row) => (typeof row.parsed.option_code === "string" && row.parsed.option_code ? [row.parsed.option_code] : [])))]
    const [options, existing] = await Promise.all([
      readIn("Failed to read options", skus, (group) => context.supabase.from("selection_options").select("id,sku,category_id,community_id,price_cents,cost_cents").eq("org_id", context.orgId).in("sku", group), optionSchema),
      readIn("Failed to read the homes' selections", projectIds, (group) => context.supabase.from("project_selections").select("project_id,category_id,selected_option_id,price_cents_snapshot,metadata").eq("org_id", context.orgId).in("project_id", group), selectionSchema),
    ])
    const existingByKey = new Map(existing.map((row) => [`${row.project_id}|${row.category_id}`, row]))
    const categoriesInFile = new Map<string, number>()
    for (const row of rows) {
      const home = homes.get(row.id)
      if (!home) { settleRow(row); continue }
      const parsed = row.parsed
      const add = (level: "error" | "warning", code: string, message: string, column?: string) => { row.issues.push({ level, code, message, column }) }
      const candidates = options.filter((option) => normalizeKey(option.sku) === normalizeKey(parsed.option_code) && (option.community_id === null || option.community_id === home.communityId))
      const option = candidates.find((item) => item.community_id === home.communityId) ?? candidates[0]
      const status = normalizeSelectionStatus(parsed.status)
      if (!status) add("error", "invalid_selection_status", "Status must be selected, confirmed, ordered or received", "status")
      else parsed.status = status
      if (typeof parsed.price_cents === "number" && parsed.price_cents < 0) add("error", "negative_price", "A selection's price cannot be negative", "price_cents")
      if (typeof parsed.selected_on === "string" && parsed.selected_on > todayUtc()) add("error", "selected_in_future", "A current selection cannot be made in the future", "selected_on")
      if (!option) { add("error", "unresolved_option", `Option ${String(parsed.option_code)} was not found`, "option_code"); settleRow(row); continue }
      parsed.option_id = option.id
      parsed.category_id = option.category_id
      parsed.cost_cents = option.cost_cents
      const key = `${home.projectId}|${option.category_id}`
      categoriesInFile.set(key, (categoriesInFile.get(key) ?? 0) + 1)
      if (typeof parsed.price_cents === "number" && option.price_cents !== null && parsed.price_cents !== option.price_cents) add("warning", "price_differs_from_catalog", `Kept at the price the buyer was given; the catalog now prices it at ${option.price_cents} cents`, "price_cents")
      const held = existingByKey.get(key)
      if (held?.selected_option_id) {
        const imported = held.metadata && typeof held.metadata === "object" && "imported_cutover" in held.metadata
        if (imported && held.selected_option_id === option.id && held.price_cents_snapshot === parsed.price_cents) add("warning", "already_imported", "This selection is already imported; it is matched and left as it is")
        else add("error", "selection_exists", "The home already has a choice in this category in Arc; it is kept", "option_code")
      }
    }
    for (const row of rows) {
      const home = homes.get(row.id)
      if (home && typeof row.parsed.category_id === "string" && (categoriesInFile.get(`${home.projectId}|${row.parsed.category_id}`) ?? 0) > 1) {
        row.issues.push({ level: "error", code: "category_twice", message: "The file gives this home two choices in the same category", column: "option_code" })
      }
      settleRow(row)
    }
    return rows
  }

  if (kind === "cutoffs") {
    const [groups, held] = await Promise.all([
      readIn("Failed to read selection groups", communityIds, (group) => context.supabase.from("selection_groups").select("id,name,community_id").eq("org_id", context.orgId).eq("is_archived", false).in("community_id", group), groupSchema),
      readIn("Failed to read the homes' cutoffs", projectIds, (group) => context.supabase.from("project_selection_groups").select("project_id,group_id,cutoff_date,cutoff_source,metadata").eq("org_id", context.orgId).in("project_id", group), projectGroupSchema),
    ])
    const { data: orgGroups, error } = await context.supabase.from("selection_groups").select("id,name,community_id").eq("org_id", context.orgId).eq("is_archived", false).is("community_id", null)
    if (error) throw new Error(`Failed to read selection groups: ${error.message}`)
    const defaults = z.array(groupSchema).parse(orgGroups ?? [])
    const heldByKey = new Map(held.map((row) => [`${row.project_id}|${row.group_id}`, row]))
    for (const row of rows) {
      const home = homes.get(row.id)
      if (!home) { settleRow(row); continue }
      const own = groups.filter((group) => group.community_id === home.communityId)
      const group = (own.length ? own : defaults).find((item) => normalizeKey(item.name) === normalizeKey(row.parsed.group))
      if (!group) { row.issues.push({ level: "error", code: "unresolved_group", message: `Selection group ${String(row.parsed.group)} was not found for this community`, column: "group" }); settleRow(row); continue }
      row.parsed.group_id = group.id
      const existing = heldByKey.get(`${home.projectId}|${group.id}`)
      if (existing?.cutoff_source === "manual_override") {
        const imported = existing.metadata && typeof existing.metadata === "object" && "imported_cutover" in existing.metadata
        if (imported && existing.cutoff_date === row.parsed.cutoff_date) row.issues.push({ level: "warning", code: "already_imported", message: "This cutoff is already imported; it is matched and left as it is" })
        else row.issues.push({ level: "error", code: "cutoff_overridden", message: "Someone moved this home's cutoff by hand in Arc; it is kept", column: "cutoff_date" })
      }
      settleRow(row)
    }
    return rows
  }

  const [agreements, balances] = await Promise.all([
    readIn("Failed to read purchase agreements", projectIds, (group) => context.supabase.from("contracts").select("id,project_id").eq("org_id", context.orgId).eq("contract_type", "purchase_agreement").eq("status", "active").in("project_id", group), contractSchema),
    readIn("Failed to read imported balances", projectIds, (group) => context.supabase.from("change_orders").select("project_id,total_cents").eq("org_id", context.orgId).not(`metadata->${IMPORTED_BALANCE_KEY}`, "is", null).in("project_id", group), balanceOrderSchema),
  ])
  for (const row of rows) {
    const home = homes.get(row.id)
    if (!home) { settleRow(row); continue }
    const parsed = row.parsed
    const add = (level: "error" | "warning", code: string, message: string, column?: string) => { row.issues.push({ level, code, message, column }) }
    if (typeof parsed.selection_count === "number" && parsed.selection_count < 0) add("error", "negative_count", "A selection count cannot be negative", "selection_count")
    if (typeof parsed.selections_total_cents === "number" && parsed.selections_total_cents < 0) add("error", "negative_total", "A selections total cannot be negative", "selections_total_cents")
    const balance = typeof parsed.change_order_balance_cents === "number" ? parsed.change_order_balance_cents : 0
    const homeAgreements = agreements.filter((agreement) => agreement.project_id === home.projectId)
    const prior = balances.filter((order) => order.project_id === home.projectId)
    if (prior.length) {
      if (prior.length === 1 && prior[0].total_cents === balance) add("warning", "already_imported", "This home's change-order balance is already imported; it is matched and left as it is")
      else add("error", "balance_already_imported", `A different change-order balance (${prior[0].total_cents ?? 0} cents) is already imported for this home`, "change_order_balance_cents")
    } else if (balance !== 0) {
      if (homeAgreements.length !== 1) add("error", "no_agreement_for_balance", "A change-order balance amends the home's one active purchase agreement, and this home has none or several", "change_order_balance_cents")
      else parsed.contract_id = homeAgreements[0].id
    }
    settleRow(row)
  }
  return rows
}

/**
 * Writes one kind of selections file. Selections land as the home's chosen,
 * priced choices (confirmed ones locked, as signing locks them); cutoffs land as
 * imported overrides the schedule never moves; a change-order balance becomes
 * one approved amendment of the home's agreement, so the price Arc closes on
 * includes it.
 */
export async function commitSelectionRows(rows: CutoverStagedRow[], context: CutoverImportContext, batchId: string, batchContext: Record<string, unknown>) {
  const kind = fileKindOf(batchContext)
  if (!context.platform) {
    await requirePermission("design_studio.manage", context)
    // Amending an agreement's price is a sales act as well as a design one.
    if (kind === "totals" && rows.some((row) => typeof row.parsed.change_order_balance_cents === "number" && row.parsed.change_order_balance_cents !== 0)) await requirePermission("sales.manage", context)
  }
  const rechecked = await validateSelectionRows(freshCopies(rows), context, batchContext)
  refuseChangedRows(rechecked)
  const results = new Map<string, { id: string; action: string }>()
  const matched = (row: CutoverStagedRow) => row.issues.some((issue) => issue.code === "already_imported")
  const provenance = (row: CutoverStagedRow) => ({ batch_id: batchId, row_id: row.id })

  if (kind !== "totals") {
    const projects = [...new Set(rechecked.filter((row) => !matched(row)).map((row) => String(row.parsed.project_id)))]
    for (const projectId of projects) await instantiateSelectionGroupsForProject(projectId, context.orgId)
  }
  for (const row of rechecked) {
    const parsed = row.parsed
    const projectId = String(parsed.project_id)
    if (matched(row)) { results.set(row.id, { id: projectId, action: "skipped_existing" }); continue }
    if (kind === "selections") {
      const status = normalizeSelectionStatus(parsed.status) ?? "confirmed"
      const at = `${String(parsed.selected_on)}T12:00:00Z`
      const { error } = await context.supabase.from("project_selections").upsert({
        org_id: context.orgId, project_id: projectId, category_id: String(parsed.category_id), selected_option_id: String(parsed.option_id), status,
        price_cents_snapshot: Number(parsed.price_cents), cost_cents_snapshot: typeof parsed.cost_cents === "number" ? parsed.cost_cents : null,
        selected_at: at, confirmed_at: status === "selected" ? null : at, locked_at: selectionLocksAtImport(status) ? at : null,
        metadata: { source: "cutover_import", imported_cutover: { ...provenance(row), price_version: parsed.price_version ?? null, source_price_cents: parsed.price_cents, selected_on: parsed.selected_on } },
      }, { onConflict: "project_id,category_id" })
      if (error) throw new Error(`Row ${row.row_number}: ${error.message}`)
    } else if (kind === "cutoffs") {
      const locked = parsed.locked === true
      const { error } = await context.supabase.from("project_selection_groups").upsert({
        org_id: context.orgId, project_id: projectId, group_id: String(parsed.group_id), cutoff_date: String(parsed.cutoff_date), cutoff_source: "manual_override",
        override_reason: "Imported at cutover from the previous system", overridden_by: context.userId, status: locked ? "locked" : "open", locked_at: locked ? `${String(parsed.cutoff_date)}T23:59:59Z` : null,
        metadata: { imported_cutover: provenance(row) },
      }, { onConflict: "project_id,group_id" })
      if (error) throw new Error(`Row ${row.row_number}: ${error.message}`)
    } else if (typeof parsed.contract_id === "string") {
      const balance = Number(parsed.change_order_balance_cents)
      const { data: order, error } = await context.supabase.from("change_orders").insert({
        org_id: context.orgId, project_id: projectId, contract_id: parsed.contract_id, title: "Option change orders through cutover (imported balance)", status: "draft",
        total_cents: balance, currency: "usd", requires_signature: false, client_visible: false, requested_by: context.userId,
        metadata: { [IMPORTED_BALANCE_KEY]: provenance(row), approval_method: "imported_balance" },
      }).select("id").single()
      // Another batch recorded this home's balance first: one balance per home, so this row matches it.
      if (error?.code === UNIQUE_VIOLATION) { results.set(row.id, { id: projectId, action: "skipped_existing" }); continue }
      if (error || !order) throw new Error(`Row ${row.row_number}: ${error?.message ?? "the balance was not recorded"}`)
      const { error: approveError } = await context.supabase.from("change_orders").update({ status: "approved", approved_by: context.userId, approved_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", order.id)
      if (approveError) {
        await context.supabase.from("change_orders").delete().eq("org_id", context.orgId).eq("id", order.id)
        throw new Error(`Row ${row.row_number}: ${approveError.message}`)
      }
      await Promise.all([
        recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "change_order_approved", entityType: "change_order", entityId: order.id, payload: { project_id: projectId, total_cents: balance, source: "cutover_import", batch_id: batchId } }),
        recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "change_order", entityId: order.id, after: { project_id: projectId, total_cents: balance, status: "approved", source: "cutover_import" } }),
      ])
    }
    results.set(row.id, { id: projectId, action: "created" })
  }
  return results
}
