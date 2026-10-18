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
import { authorize } from "@/lib/services/authorization"

export async function loadInventoryPolicies(orgId: string) {
  const service = createServiceSupabaseClient()
  const rows = await collectBooksRows((from, to) => service.from("project_financial_settings")
    .select("project_id,books_inventory_enabled,books_inventory_effective_on,books_inventory_completed_on,books_inventory_sold_on,books_inventory_evidence_url")
    .eq("org_id", orgId).eq("books_inventory_enabled", true).order("project_id").range(from, to))
  return new Map(rows.map(row => [String(row.project_id), { enabled: true, effectiveOn: row.books_inventory_effective_on, completedOn: row.books_inventory_completed_on, soldOn: row.books_inventory_sold_on, evidenceUrl: row.books_inventory_evidence_url } satisfies InventoryPolicy & { evidenceUrl: string | null }]))
}
async function inventoryContext(permission: "books.manage" | "books.adjust" | "books.close") {
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

/** Entries the correction list shows; a longer history says so instead of paging silently. */
const LAND_CORRECTION_CAP = 50
export async function getLandAcquisitionWorkspace() {
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [lots, accounts, debt, owned, starts] = await Promise.all([
    collectBooksRows((from,to) => service.from("lots").select("id,lot_number,community:communities(name)").eq("org_id",context.orgId).eq("status","controlled").order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name").eq("org_id",context.orgId).eq("active",true).eq("subtype","cash").order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("books_debt_instruments").select("id,name").eq("org_id",context.orgId).eq("active",true).order("id").range(from,to)),
    service.from("lots").select("id,lot_number,cost_basis_cents,books_acquisition_entry_id,community:communities(name),entry:journal_entries!lots_books_acquisition_entry_id_fkey(entry_date,memo)")
      .eq("org_id",context.orgId).eq("status","owned").not("books_acquisition_entry_id","is",null).order("acquired_date",{ ascending: false }).limit(LAND_CORRECTION_CAP + 1),
    service.from("journal_entries").select("source_id,entry_date,memo").eq("org_id",context.orgId).eq("source_type","inventory_start").eq("status","posted").order("entry_date",{ ascending: false }).limit(LAND_CORRECTION_CAP + 1),
  ])
  if (owned.error) throw new Error(`Failed to load acquired lots: ${owned.error.message}`)
  if (starts.error) throw new Error(`Failed to load start transfers: ${starts.error.message}`)
  const label = (lot: { lot_number: string | number; community: unknown }) => { const community = Array.isArray(lot.community) ? lot.community[0] : lot.community; return `${community && typeof community === "object" && "name" in community ? String(community.name) : "Community"} · Lot ${lot.lot_number}` }
  const startRows = starts.data.slice(0, LAND_CORRECTION_CAP)
  const startLots = startRows.length === 0 ? [] : await collectBooksRows((from,to) => service.from("lots").select("id,lot_number,community:communities(name)").eq("org_id",context.orgId).in("id",startRows.map(row => String(row.source_id))).order("id").range(from,to))
  const startLotById = new Map(startLots.map(lot => [lot.id, lot]))
  const acquisitions = new Map<string, { entryId: string; date: string; memo: string; lots: { id: string; name: string; amountCents: number }[] }>()
  for (const lot of owned.data.slice(0, LAND_CORRECTION_CAP)) {
    const entry = Array.isArray(lot.entry) ? lot.entry[0] : lot.entry
    const entryId = String(lot.books_acquisition_entry_id)
    const group = acquisitions.get(entryId) ?? { entryId, date: String(entry?.entry_date ?? ""), memo: String(entry?.memo ?? "Land acquisition"), lots: [] }
    group.lots.push({ id: lot.id, name: label(lot), amountCents: Number(lot.cost_basis_cents ?? 0) })
    acquisitions.set(entryId, group)
  }
  return {
    lots: lots.map(lot => ({ id: lot.id, name: label(lot) })), accounts, debt,
    acquisitions: [...acquisitions.values()],
    startTransfers: startRows.flatMap(row => { const lot = startLotById.get(String(row.source_id)); return lot ? [{ lotId: lot.id, name: label(lot), date: String(row.entry_date) }] : [] }),
    correctionCap: LAND_CORRECTION_CAP,
    correctionsTruncated: owned.data.length > LAND_CORRECTION_CAP || starts.data.length > LAND_CORRECTION_CAP,
  }
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

const landReversalSchema = z.object({ entryId: z.string().uuid(), date: z.string().date(), reason: z.string().trim().min(5).max(500) })
/**
 * Reverses a posted land acquisition so it can be recorded again with the right
 * amount, date or lot. The lots return to controlled; the original, its reversal
 * and the replacement stay in the ledger. Retrying returns the same reversal.
 */
export async function reverseLandAcquisition(input: z.input<typeof landReversalSchema>) {
  const parsed = landReversalSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("reverse_books_land_acquisition", { p_org_id: context.orgId, p_entry_id: parsed.entryId, p_date: parsed.date, p_reason: parsed.reason, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to reverse land acquisition: ${error.message}`)
  const reversalEntryId = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "journal_entry", entityId: parsed.entryId, after: { ...parsed, reversal_entry_id: reversalEntryId }, source: "books.land_acquisition_reversal" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.land_acquisition_reversed", entityType: "journal_entry", entityId: parsed.entryId, payload: { reversal_entry_id: reversalEntryId, reason: parsed.reason } })
  return { reversalEntryId }
}

const landStartCorrectionSchema = z.object({ lotId: z.string().uuid(), reversalDate: z.string().date(), reason: z.string().trim().min(5).max(500), repostDate: z.string().date().nullable() })
/** Reverses a lot's start transfer and, when a date is given, posts it again on that date. */
export async function correctLandStartTransfer(input: z.input<typeof landStartCorrectionSchema>) {
  const parsed = landStartCorrectionSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("correct_books_land_start_transfer", { p_org_id: context.orgId, p_lot_id: parsed.lotId, p_reversal_date: parsed.reversalDate, p_reason: parsed.reason, p_repost_date: parsed.repostDate, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to correct the start transfer: ${error.message}`)
  const result = z.object({ reversal_entry_id: z.string().uuid(), transfer: z.object({ status: z.string(), id: z.string().uuid().optional() }).nullable() }).parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot", entityId: parsed.lotId, after: { ...parsed, ...result }, source: "books.land_start_correction" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.land_start_corrected", entityType: "lot", entityId: parsed.lotId, payload: { reversal_entry_id: result.reversal_entry_id, transfer_entry_id: result.transfer?.id ?? null, reason: parsed.reason } })
  return { reversalEntryId: result.reversal_entry_id, transferEntryId: result.transfer?.id ?? null }
}

const ALLOCATION_BASES = ["equal", "front_footage", "square_footage", "sales_value", "custom"] as const
const allocationProposalSchema = z.object({
  projectId: z.string().uuid(), date: z.string().date(), reference: z.string().trim().min(3).max(120),
  basis: z.enum(ALLOCATION_BASES), totalCents: z.number().int().safe().positive(),
  weights: z.array(z.object({ lotId: z.string().uuid(), weight: z.number().positive().finite() })).min(1).max(250),
  evidenceUrl: z.string().url().startsWith("https://"), note: z.string().trim().min(10).max(4000),
})
/**
 * Proposes how shared development cost is spread across lots: the basis, each
 * lot's weight and the total. The database computes exact-cent shares; nothing
 * posts until a different member approves it (`reviewDevelopmentAllocation`).
 */
export async function proposeDevelopmentAllocation(input: z.input<typeof allocationProposalSchema>) {
  const parsed = allocationProposalSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("propose_books_development_allocation", {
    p_org_id: context.orgId, p_project_id: parsed.projectId, p_date: parsed.date, p_reference: parsed.reference, p_basis: parsed.basis,
    p_total_cents: parsed.totalCents, p_weights: parsed.weights.map(row => ({ lot_id: row.lotId, weight: row.weight })), p_evidence_url: parsed.evidenceUrl, p_note: parsed.note, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_development_allocation", entityId: id, after: parsed, source: "books.development_allocation" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.development_allocation_proposed", entityType: "project", entityId: parsed.projectId, payload: { allocation_id: id } })
  return { id }
}
/** Approves (and posts) or rejects a proposed allocation. The proposer cannot approve it. */
export async function reviewDevelopmentAllocation(input: { allocationId: string; approve: boolean; note?: string }) {
  const parsed = z.object({ allocationId: z.string().uuid(), approve: z.boolean(), note: z.string().trim().max(4000).optional() }).parse(input)
  const context = await inventoryContext("books.close")
  const { data, error } = await createServiceSupabaseClient().rpc("review_books_development_allocation", { p_org_id: context.orgId, p_allocation_id: parsed.allocationId, p_approve: parsed.approve, p_note: parsed.note ?? null, p_actor_id: context.userId })
  if (error) throw new Error(error.message)
  const result = z.object({ allocationId: z.string().uuid(), projectId: z.string().uuid(), status: z.enum(["approved", "rejected"]), journalEntryId: z.string().uuid().nullable() }).parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_development_allocation", entityId: parsed.allocationId, after: result, source: "books.development_allocation" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `books.development_allocation_${result.status}`, entityType: "project", entityId: result.projectId, payload: { allocation_id: parsed.allocationId, journal_entry_id: result.journalEntryId } })
  return result
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
/**
 * What a development allocation from this job can reach: acquired, unstarted
 * lots in the phases the job develops (the database refuses any other), plus
 * the interest and pending proposals the workspace shows.
 */
export async function getInventoryAllocationWorkspace(projectId: string) {
  const parsedProjectId = z.string().uuid().parse(projectId)
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [lots, interest] = await Promise.all([
    collectBooksRows((from,to) => service.from("lots").select("id,lot_number,phase:community_phases!inner(development_project_id)").eq("org_id",context.orgId).eq("phase.development_project_id",parsedProjectId).in("status",["owned","developed","assigned"]).not("books_acquisition_entry_id","is",null).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("journal_lines").select("id,debit_cents,description,entry:journal_entries!journal_lines_entry_owner_fk!inner(entry_date,status),account:gl_accounts!journal_lines_account_owner_fk!inner(subtype)").eq("org_id",context.orgId).eq("entry.status","posted").eq("account.subtype","interest").gt("debit_cents",0).order("id").range(from,to)),
  ])
  const { data: proposals, error: proposalError } = await service.from("books_development_allocations").select("id,project_id,reference,basis,total_cents,shares,note,prepared_by,prepared_at").eq("org_id", context.orgId).eq("status", "proposed").order("prepared_at").limit(100)
  if (proposalError) throw new Error(`Failed to load allocation proposals: ${proposalError.message}`)
  const lotName = new Map(lots.map(row => [String(row.id), `Lot ${row.lot_number}`]))
  return { userId: context.userId, pending: (proposals ?? []).map(row => ({ id: String(row.id), projectId: String(row.project_id), reference: String(row.reference), basis: String(row.basis), totalCents: Number(row.total_cents), note: String(row.note), preparedBy: String(row.prepared_by),
    shares: z.array(z.object({ lot_id: z.string(), amount_cents: z.number() })).parse(row.shares).map(share => ({ lot: lotName.get(share.lot_id) ?? "Lot", cents: share.amount_cents })) })),
    lots: lots.map(row => ({ id: row.id, name: `Lot ${row.lot_number}` })), interest: interest.map(row => { const entry = Array.isArray(row.entry) ? row.entry[0] : row.entry; return { id: row.id, amountCents: Number(row.debit_cents), label: `${entry?.entry_date} · ${row.description ?? "Interest expense"}` } }) }
}

const impairmentSchema = z.object({
  projectId: z.string().uuid(), asOf: z.string().date(),
  sellingPriceCents: z.number().int().safe().nonnegative(), costToCompleteCents: z.number().int().safe().nonnegative(), costToSellCents: z.number().int().safe().nonnegative(),
  evidenceUrl: z.string().url().startsWith("https://"), assumptions: z.string().trim().min(10).max(4000),
})
const impairmentRowSchema = z.object({
  id: z.string().uuid(), as_of: z.string(), carrying_cents: z.number(), selling_price_cents: z.number(), cost_to_complete_cents: z.number(), cost_to_sell_cents: z.number(),
  net_realizable_cents: z.number(), write_down_cents: z.number(), evidence_url: z.string(), assumptions: z.string(), status: z.enum(["proposed", "approved", "rejected"]),
  prepared_by: z.string().uuid(), reviewed_by: z.string().uuid().nullable(), reviewed_at: z.string().nullable(), review_note: z.string().nullable(),
})

/** A home's impairment reviews, newest first, with what it carries today. */
export async function getInventoryImpairmentWorkspace(projectId: string) {
  const parsedId = z.string().uuid().parse(projectId)
  const context = await inventoryContext("books.adjust")
  const service = createServiceSupabaseClient()
  const [carrying, reviews] = await Promise.all([
    service.rpc("books_home_carrying_cents", { p_org_id: context.orgId, p_project_id: parsedId, p_as_of: new Date().toISOString().slice(0, 10) }),
    service.from("books_inventory_impairments").select("id,as_of,carrying_cents,selling_price_cents,cost_to_complete_cents,cost_to_sell_cents,net_realizable_cents,write_down_cents,evidence_url,assumptions,status,prepared_by,reviewed_by,reviewed_at,review_note")
      .eq("org_id", context.orgId).eq("project_id", parsedId).order("prepared_at", { ascending: false }).limit(50),
  ])
  if (carrying.error) throw new Error(`Failed to read the home's cost: ${carrying.error.message}`)
  if (reviews.error) throw new Error(`Failed to load impairment reviews: ${reviews.error.message}`)
  const rows = z.array(impairmentRowSchema).parse(reviews.data ?? [])
  return { userId: context.userId, carryingCents: Number(carrying.data ?? 0), reviews: rows.map(row => ({
    id: row.id, asOf: row.as_of, carryingCents: row.carrying_cents, sellingPriceCents: row.selling_price_cents, costToCompleteCents: row.cost_to_complete_cents, costToSellCents: row.cost_to_sell_cents,
    netRealizableCents: row.net_realizable_cents, writeDownCents: row.write_down_cents, evidenceUrl: row.evidence_url, assumptions: row.assumptions, status: row.status,
    preparedBy: row.prepared_by, reviewedAt: row.reviewed_at, reviewNote: row.review_note })) }
}

/**
 * Prepares an impairment review of a home: its cost as of the date against net
 * realizable value (expected price less cost to complete and cost to sell). The
 * database refuses one where value covers cost; nothing posts until a different
 * member approves it.
 */
export async function proposeInventoryImpairment(input: z.input<typeof impairmentSchema>) {
  const parsed = impairmentSchema.parse(input)
  const context = await inventoryContext("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("propose_books_inventory_impairment", {
    p_org_id: context.orgId, p_project_id: parsed.projectId, p_as_of: parsed.asOf, p_selling_price_cents: parsed.sellingPriceCents,
    p_cost_to_complete_cents: parsed.costToCompleteCents, p_cost_to_sell_cents: parsed.costToSellCents, p_evidence_url: parsed.evidenceUrl, p_assumptions: parsed.assumptions, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const id = z.string().uuid().parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_inventory_impairment", entityId: id, after: parsed, source: "books.inventory_impairment" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.inventory_impairment_proposed", entityType: "project", entityId: parsed.projectId, payload: { impairment_id: id } })
  return { id }
}

/** Approves (and posts the write-down) or rejects an impairment review. The preparer cannot approve it. */
export async function reviewInventoryImpairment(input: { impairmentId: string; approve: boolean; note?: string }) {
  const parsed = z.object({ impairmentId: z.string().uuid(), approve: z.boolean(), note: z.string().trim().max(4000).optional() }).parse(input)
  const context = await inventoryContext("books.close")
  const { data, error } = await createServiceSupabaseClient().rpc("review_books_inventory_impairment", { p_org_id: context.orgId, p_impairment_id: parsed.impairmentId, p_approve: parsed.approve, p_note: parsed.note ?? null, p_actor_id: context.userId })
  if (error) throw new Error(error.message)
  const result = z.object({ impairmentId: z.string().uuid(), projectId: z.string().uuid(), status: z.enum(["approved", "rejected"]), journalEntryId: z.string().uuid().nullable() }).parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_inventory_impairment", entityId: parsed.impairmentId, after: result, source: "books.inventory_impairment" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `books.inventory_impairment_${result.status}`, entityType: "project", entityId: result.projectId, payload: { impairment_id: parsed.impairmentId, journal_entry_id: result.journalEntryId } })
  return result
}

/** Pending reviews listed on the desk; the desk says when it truncates. */
const DESK_PENDING_LIMIT = 100

/**
 * The accountant's view of homes the builder owns: completed homes held for sale
 * with their age and cost (spec aging, read from the ledger), and the write-downs
 * and land allocations waiting for a second member. Reviews are decided here with
 * the same actions as on the home; nothing else changes from this desk.
 */
export async function getOwnedInventoryDesk() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
  const service = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const [controls, impairments, allocations, canReview] = await Promise.all([
    service.rpc("books_home_inventory_controls", { p_org_id: context.orgId, p_as_of: today }),
    service.from("books_inventory_impairments").select("id,project_id,as_of,carrying_cents,selling_price_cents,cost_to_complete_cents,cost_to_sell_cents,net_realizable_cents,write_down_cents,assumptions,evidence_url,prepared_by", { count: "exact" })
      .eq("org_id", context.orgId).eq("status", "proposed").order("prepared_at").limit(DESK_PENDING_LIMIT),
    service.from("books_development_allocations").select("id,project_id,reference,basis,total_cents,shares,note,prepared_by", { count: "exact" })
      .eq("org_id", context.orgId).eq("status", "proposed").order("prepared_at").limit(DESK_PENDING_LIMIT),
    authorize({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false }).then(decision => decision.allowed && decision.divisionScope !== "assigned"),
  ])
  if (controls.error) throw new Error(`Failed to read owned homes: ${controls.error.message}`)
  if (impairments.error) throw new Error(`Failed to load impairment reviews: ${impairments.error.message}`)
  if (allocations.error) throw new Error(`Failed to load land allocations: ${allocations.error.message}`)
  const held = z.object({ completedHomes: z.object({ homes: z.array(z.object({ projectId: z.string().uuid(), completedOn: z.string(), ageDays: z.number(), cents: z.number() })) }) }).parse(controls.data).completedHomes.homes
  const pendingImpairments = z.array(impairmentRowSchema.pick({ id: true, as_of: true, carrying_cents: true, selling_price_cents: true, cost_to_complete_cents: true, cost_to_sell_cents: true, net_realizable_cents: true, write_down_cents: true, assumptions: true, evidence_url: true, prepared_by: true }).extend({ project_id: z.string().uuid() })).parse(impairments.data ?? [])
  const pendingAllocations = z.array(z.object({ id: z.string().uuid(), project_id: z.string().uuid(), reference: z.string(), basis: z.string(), total_cents: z.number(), shares: z.array(z.object({ lot_id: z.string(), amount_cents: z.number() })), note: z.string(), prepared_by: z.string().uuid() })).parse(allocations.data ?? [])
  const projectIds = [...new Set([...held.map(row => row.projectId), ...pendingImpairments.map(row => row.project_id), ...pendingAllocations.map(row => row.project_id)])]
  const lotIds = [...new Set(pendingAllocations.flatMap(row => row.shares.map(share => share.lot_id)))]
  const [projects, lots] = await Promise.all([
    projectIds.length ? service.from("projects").select("id,name").eq("org_id", context.orgId).in("id", projectIds) : Promise.resolve({ data: [], error: null }),
    lotIds.length ? service.from("lots").select("id,lot_number").eq("org_id", context.orgId).in("id", lotIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (projects.error) throw new Error(`Failed to load homes: ${projects.error.message}`)
  if (lots.error) throw new Error(`Failed to load lots: ${lots.error.message}`)
  const name = new Map((projects.data ?? []).map(row => [String(row.id), String(row.name)]))
  const lotName = new Map((lots.data ?? []).map(row => [String(row.id), `Lot ${row.lot_number}`]))
  return {
    userId: context.userId, canReview,
    held: held.map(row => ({ projectId: row.projectId, name: name.get(row.projectId) ?? "Home", completedOn: row.completedOn, ageDays: row.ageDays, cents: row.cents })).sort((a, b) => b.ageDays - a.ageDays),
    impairments: pendingImpairments.map(row => ({ id: row.id, name: name.get(row.project_id) ?? "Home", asOf: row.as_of, carryingCents: row.carrying_cents,
      sellingPriceCents: row.selling_price_cents, costToCompleteCents: row.cost_to_complete_cents, costToSellCents: row.cost_to_sell_cents, netRealizableCents: row.net_realizable_cents,
      writeDownCents: row.write_down_cents, assumptions: row.assumptions, evidenceUrl: row.evidence_url, preparedBy: row.prepared_by })),
    allocations: pendingAllocations.map(row => ({ id: row.id, name: name.get(row.project_id) ?? "Development", reference: row.reference, basis: row.basis, totalCents: row.total_cents, note: row.note, preparedBy: row.prepared_by,
      shares: row.shares.map(share => ({ lot: lotName.get(share.lot_id) ?? "Lot", cents: share.amount_cents })) })),
    truncated: (impairments.count ?? 0) > pendingImpairments.length || (allocations.count ?? 0) > pendingAllocations.length,
  }
}
