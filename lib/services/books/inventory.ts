import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { type InventoryPolicy } from "@/lib/services/books/inventory-rules"
import { loadRevenueBasisByProject } from "@/lib/services/books/revenue-basis"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export async function loadInventoryPolicies(orgId: string) {
  const service = createServiceSupabaseClient()
  const rows = await collectBooksRows((from, to) => service.from("project_financial_settings")
    .select("project_id,books_inventory_enabled,books_inventory_effective_on,books_inventory_completed_on,books_inventory_sold_on,books_inventory_evidence_url")
    .eq("org_id", orgId).eq("books_inventory_enabled", true).order("project_id").range(from, to))
  return new Map(rows.map(row => [String(row.project_id), { enabled: true, effectiveOn: row.books_inventory_effective_on, completedOn: row.books_inventory_completed_on, soldOn: row.books_inventory_sold_on, evidenceUrl: row.books_inventory_evidence_url } satisfies InventoryPolicy & { evidenceUrl: string | null }]))
}
async function inventoryContext(permission: "books.manage" | "books.adjust") {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: true })
  return context
}
export async function enableProjectInventory(input: { projectId: string; effectiveOn: string; evidenceUrl: string }) {
  const parsed = z.object({ projectId: z.string().uuid(), effectiveOn: z.string().date(), evidenceUrl: z.string().url().startsWith("https://") }).parse(input)
  const context = await inventoryContext("books.manage")
  const basis = await loadRevenueBasisByProject(context.orgId)
  if (basis.get(parsed.projectId) !== "closing") throw new Error("Owned-home inventory requires a project that recognizes revenue at sale. Review the project's financial posture first.")
  const { error } = await createServiceSupabaseClient().rpc("enable_books_project_inventory", { p_org_id: context.orgId, p_project_id: parsed.projectId, p_effective_on: parsed.effectiveOn, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to adopt inventory accounting: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, after: parsed, source: "books.inventory_policy" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.inventory_policy_adopted", entityType: "project", entityId: parsed.projectId })
  return { enabled: true }
}
export async function transitionInventoryForService(input: { orgId: string; projectId: string; transition: "completion" | "sale_relief"; date: string; evidenceUrl: string; actorId?: string | null }) {
  const { data, error } = await createServiceSupabaseClient().rpc("transition_books_project_inventory", { p_org_id: input.orgId, p_project_id: input.projectId, p_transition: input.transition, p_date: input.date, p_evidence_url: input.evidenceUrl, p_actor_id: input.actorId ?? null })
  if (error) throw new Error(`Failed to post inventory ${input.transition}: ${error.message}`)
  return z.object({ status: z.enum(["posted", "not_enabled"]), id: z.string().uuid().nullable().optional(), amount_cents: z.number().int().optional() }).parse(data)
}
export async function completeProjectInventory(input: { projectId: string; date: string; evidenceUrl: string }) {
  const parsed = z.object({ projectId: z.string().uuid(), date: z.string().date(), evidenceUrl: z.string().url().startsWith("https://") }).parse(input)
  const context = await inventoryContext("books.adjust")
  const result = await transitionInventoryForService({ ...parsed, orgId: context.orgId, actorId: context.userId, transition: "completion" })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, after: { ...parsed, journal_entry_id: result.id }, source: "books.inventory_completion" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.inventory_completed", entityType: "project", entityId: parsed.projectId, payload: { journal_entry_id: result.id } })
  return result
}

export async function getInventoryWorkspace() {
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [policies, bases, projects] = await Promise.all([
    loadInventoryPolicies(context.orgId), loadRevenueBasisByProject(context.orgId),
    collectBooksRows((from, to) => service.from("projects").select("id,name").eq("org_id", context.orgId).order("id").range(from, to)),
  ])
  return projects.filter(project => bases.get(project.id) === "closing").map(project => ({ id: project.id, name: project.name, policy: policies.get(project.id) ?? null }))
}

export async function getLandAcquisitionWorkspace() {
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [lots, accounts, debt] = await Promise.all([
    collectBooksRows((from,to) => service.from("lots").select("id,lot_number,community:communities(name)").eq("org_id",context.orgId).eq("status","controlled").order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name").eq("org_id",context.orgId).eq("active",true).eq("subtype","cash").order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("books_debt_instruments").select("id,name").eq("org_id",context.orgId).eq("active",true).order("id").range(from,to)),
  ])
  return { lots: lots.map(lot => { const community = Array.isArray(lot.community) ? lot.community[0] : lot.community; return { id: lot.id, name: `${community?.name ?? "Community"} · Lot ${lot.lot_number}` } }), accounts, debt }
}
const landAcquisitionSchema = z.object({
  date: z.string().date(), allocations: z.array(z.object({ lotId: z.string().uuid(), amountCents: z.number().int().safe().positive() })).min(1).max(250),
  cashAccountId: z.string().uuid().nullable(), cashCents: z.number().int().safe().nonnegative(), debtInstrumentId: z.string().uuid().nullable(), debtCents: z.number().int().safe().nonnegative(), reference: z.string().trim().min(3).max(120), evidenceUrl: z.string().url().startsWith("https://"),
})
export async function acquireLandInventory(input: z.input<typeof landAcquisitionSchema>) {
  const parsed = landAcquisitionSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("acquire_books_land", { p_org_id: context.orgId, p_date: parsed.date, p_allocations: parsed.allocations.map(row => ({ lot_id: row.lotId, amount_cents: row.amountCents })), p_cash_account_id: parsed.cashAccountId, p_cash_cents: parsed.cashCents, p_debt_instrument_id: parsed.debtInstrumentId, p_debt_cents: parsed.debtCents, p_reference: parsed.reference, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to record land acquisition: ${error.message}`)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot", entityId: parsed.allocations[0].lotId, after: { ...parsed, journal_entry_id: id }, source: "books.land_acquisition" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.land_acquired", entityType: "lot", entityId: parsed.allocations[0].lotId, payload: { journal_entry_id: id, lot_ids: parsed.allocations.map(row => row.lotId) } })
  return { id }
}
export async function transferLandAtStartForService(orgId: string, lotId: string, date: string, actorId: string | null) {
  const { error } = await createServiceSupabaseClient().rpc("transfer_books_land_to_start", { p_org_id: orgId, p_lot_id: lotId, p_date: date, p_actor_id: actorId })
  if (error) throw new Error(`Failed to transfer lot basis to construction: ${error.message}`)
}

const allocationSchema = z.object({ projectId: z.string().uuid(), date: z.string().date(), allocations: z.array(z.object({ lotId: z.string().uuid(), amountCents: z.number().int().safe().positive() })).min(1).max(250), reference: z.string().trim().min(3).max(120), evidenceUrl: z.string().url().startsWith("https://") })
export async function allocateDevelopmentInventory(input: z.input<typeof allocationSchema>) {
  const parsed = allocationSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("allocate_books_development_cost", { p_org_id: context.orgId, p_project_id: parsed.projectId, p_date: parsed.date, p_allocations: parsed.allocations.map(row => ({ lot_id: row.lotId, amount_cents: row.amountCents })), p_reference: parsed.reference, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to allocate development inventory: ${error.message}`)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, after: { ...parsed, journal_entry_id: id }, source: "books.development_allocation" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.development_allocated", entityType: "project", entityId: parsed.projectId, payload: { journal_entry_id: id } })
  return { id }
}
const interestSchema = z.object({ projectId: z.string().uuid(), sourceLineId: z.string().uuid(), date: z.string().date(), amountCents: z.number().int().safe().positive(), reference: z.string().trim().min(3).max(120), evidenceUrl: z.string().url().startsWith("https://") })
export async function capitalizeInventoryInterest(input: z.input<typeof interestSchema>) {
  const parsed = interestSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("capitalize_books_inventory_interest", { p_org_id: context.orgId, p_project_id: parsed.projectId, p_source_line_id: parsed.sourceLineId, p_date: parsed.date, p_amount_cents: parsed.amountCents, p_reference: parsed.reference, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to capitalize interest: ${error.message}`)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, after: { ...parsed, journal_entry_id: id }, source: "books.interest_capitalization" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.interest_capitalized", entityType: "project", entityId: parsed.projectId, payload: { journal_entry_id: id } })
  return { id }
}
export async function getInventoryAllocationWorkspace() {
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [lots, interest] = await Promise.all([
    collectBooksRows((from,to) => service.from("lots").select("id,lot_number").eq("org_id",context.orgId).in("status",["owned","developed","assigned"]).not("books_acquisition_entry_id","is",null).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("journal_lines").select("id,debit_cents,description,entry:journal_entries!inner(entry_date,status),account:gl_accounts!inner(subtype)").eq("org_id",context.orgId).eq("entry.status","posted").eq("account.subtype","interest").gt("debit_cents",0).order("id").range(from,to)),
  ])
  return { lots: lots.map(row => ({ id: row.id, name: `Lot ${row.lot_number}` })), interest: interest.map(row => { const entry = Array.isArray(row.entry) ? row.entry[0] : row.entry; return { id: row.id, amountCents: Number(row.debit_cents), label: `${entry?.entry_date} · ${row.description ?? "Interest expense"}` } }) }
}
