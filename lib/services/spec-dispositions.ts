import { z } from "zod"

import { specDispositionExecutionBlock } from "@/lib/sales/spec-inventory"
import { recordAudit } from "@/lib/services/audit"
import { proposeInventoryImpairment } from "@/lib/services/books/inventory"
import {
  assertCommunityInSalesScope,
  getSalesCommunityIds,
  readImpairmentStatuses,
  readStandingSpec,
  type SpecPendingChange,
} from "@/lib/services/community-sales"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import {
  specCompletionSchema,
  specDispositionDecisionSchema,
  specDispositionReferenceSchema,
  specDispositionSchema,
  specDispositionWriteDownSchema,
} from "@/lib/validation/spec-inventory"

/**
 * Selling off standing specs: the facts sales records on a finished home and the
 * disposition of one that retail will not absorb.
 *
 * A disposition is a sale, not a new kind of exit. It names a buyer and a price,
 * a second person approves it, and it is carried out by the ordinary purchase
 * agreement written to that buyer — the agreement prices the home at the
 * approved figure (`priceAgreementDraft`) — and the ordinary closing. That is
 * why margin baselines, Books sale relief and cancellation evidence work
 * unchanged: nothing here writes `home_margin_baselines`, a reservation or a
 * cancellation. Below what Books carries for the home, the sale waits for an
 * approved write-down (`books_inventory_impairments`), which the database also
 * enforces when the disposition is carried out.
 */

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

const DISPOSITION_SELECT = "id, lot_id, project_id, community_id, kind, counterparty_contact_id, counterparty_company_id, price_cents, carrying_cents, status, proposed_by, impairment_id, contract_id"

const dispositionRowSchema = z.object({
  id: z.string().uuid(),
  lot_id: z.string().uuid(),
  project_id: z.string().uuid(),
  community_id: z.string().uuid(),
  kind: z.enum(["bulk_sale", "investor_sale"]),
  counterparty_contact_id: z.string().uuid(),
  counterparty_company_id: z.string().uuid().nullable(),
  price_cents: z.coerce.number().int(),
  carrying_cents: z.coerce.number().int(),
  status: z.enum(["proposed", "approved", "rejected", "executed", "cancelled"]),
  proposed_by: z.string().uuid(),
  impairment_id: z.string().uuid().nullable(),
  contract_id: z.string().uuid().nullable(),
})
type DispositionRow = z.infer<typeof dispositionRowSchema>

/** The disposition an agreement was priced through, as its snapshot records it (`priceAgreementDraft`). */
const agreementDispositionSchema = z.object({
  purchase_agreement: z.object({ pricing: z.object({ disposition: z.object({ id: z.string().uuid(), kind: z.string() }).nullable().optional() }) }),
})

function agreementDispositionId(snapshot: unknown): string | null {
  const parsed = agreementDispositionSchema.safeParse(snapshot)
  return parsed.success ? parsed.data.purchase_agreement.pricing.disposition?.id ?? null : null
}

async function readDisposition(context: OrgContext, dispositionId: string): Promise<DispositionRow> {
  const { data, error } = await context.supabase.from("spec_dispositions").select(DISPOSITION_SELECT).eq("org_id", context.orgId).eq("id", dispositionId).maybeSingle()
  if (error || !data) throw new Error("Disposition not found")
  const row = dispositionRowSchema.parse(data)
  await assertCommunityInSalesScope(context, row.community_id)
  return row
}

function dispositionPayload(row: DispositionRow) {
  return { lot_id: row.lot_id, project_id: row.project_id, community_id: row.community_id, kind: row.kind, price_cents: row.price_cents, carrying_cents: row.carrying_cents }
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Record the day a home was finished, for a home Books does not carry: from
 * then on it ages as standing inventory. A date Books recorded is Books' to
 * change; a recorded date is never in the future; changing one needs a reason.
 */
export async function recordSpecCompletion(input: unknown, orgId?: string) {
  const parsed = specCompletionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  if (parsed.completedOn > today()) throw new Error("A completion date cannot be in the future.")
  const [project, lot, books] = await Promise.all([
    context.supabase.from("projects").select("id, completed_on").eq("org_id", context.orgId).eq("id", parsed.projectId).maybeSingle(),
    context.supabase.from("lots").select("id, community_id").eq("org_id", context.orgId).eq("project_id", parsed.projectId).limit(1).maybeSingle(),
    context.supabase.from("project_financial_settings").select("books_inventory_completed_on").eq("org_id", context.orgId).eq("project_id", parsed.projectId).maybeSingle(),
  ])
  if (project.error || !project.data || lot.error || !lot.data) throw new Error("Home not found")
  if (books.error) throw new Error(`Failed to read the home's Books record: ${books.error.message}`)
  await assertCommunityInSalesScope(context, lot.data.community_id)
  if (books.data?.books_inventory_completed_on) {
    throw new Error(`Books recorded this home complete on ${books.data.books_inventory_completed_on}; that date is changed in Books.`)
  }
  const previous: string | null = project.data.completed_on ?? null
  if (previous === parsed.completedOn) return { projectId: parsed.projectId, completedOn: previous }
  if (previous && (parsed.reason ?? "").length < 10) throw new Error("Say why the recorded completion date is changing (at least 10 characters).")
  const guarded = context.supabase.from("projects").update({ completed_on: parsed.completedOn }).eq("org_id", context.orgId).eq("id", parsed.projectId)
  const { data: updated, error } = await (previous ? guarded.eq("completed_on", previous) : guarded.is("completed_on", null)).select("id").maybeSingle()
  if (error) throw new Error(`Failed to record the completion: ${error.message}`)
  if (!updated) throw new Error("The home's completion changed while you were recording it. Review it and try again.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.completion_recorded", entityType: "project", entityId: parsed.projectId, payload: { lot_id: lot.data.id, completed_on: parsed.completedOn, previous_completed_on: previous } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, before: { completed_on: previous }, after: { completed_on: parsed.completedOn, reason: parsed.reason ?? null } }),
  ])
  return { projectId: parsed.projectId, completedOn: parsed.completedOn }
}

/**
 * Propose selling a standing spec off to a bulk or investor buyer at a price.
 * The database captures what Books carries for the home as the row is written
 * (never a figure the caller supplies), so the approver sees the loss the price
 * implies and execution knows whether a write-down is owed.
 */
export async function proposeSpecDisposition(input: unknown, orgId?: string) {
  const parsed = specDispositionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const home = await readStandingSpec(context, parsed.lotId)
  if (home.disposition) throw new Error("This home already has a disposition in progress.")
  if (home.pendingChange) throw new Error("A price change is waiting for approval on this home. Decide or withdraw it first.")
  const { data, error } = await context.supabase.from("spec_dispositions").insert({
    org_id: context.orgId,
    lot_id: home.lot.id,
    project_id: home.lot.projectId,
    community_id: home.lot.communityId,
    kind: parsed.kind,
    counterparty_contact_id: parsed.counterpartyContactId,
    counterparty_company_id: parsed.counterpartyCompanyId,
    price_cents: parsed.priceCents,
    asking_price_cents: home.askingPriceCents,
    reason: parsed.reason,
    status: "proposed",
    proposed_by: context.userId,
    impairment_id: null,
    contract_id: null,
  }).select(DISPOSITION_SELECT).single()
  if (error?.code === "23505") throw new Error("This home already has a disposition in progress.")
  if (error || !data) throw new Error(`Failed to propose the disposition: ${error?.message}`)
  const row = dispositionRowSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.disposition_proposed", entityType: "spec_disposition", entityId: row.id, payload: dispositionPayload(row) }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "spec_disposition", entityId: row.id, after: { ...dispositionPayload(row), reason: parsed.reason, asking_price_cents: home.askingPriceCents } }),
  ])
  return { dispositionId: row.id, status: row.status, carryingCents: row.carrying_cents }
}

/** Approve or reject a proposed disposition; the proposer never decides it. */
export async function decideSpecDisposition(input: unknown, orgId?: string) {
  const parsed = specDispositionDecisionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.disposition_approve", context)
  const row = await readDisposition(context, parsed.dispositionId)
  if (row.status !== "proposed") throw new Error("This disposition was already decided or cancelled.")
  if (row.proposed_by === context.userId) throw new Error("A disposition must be approved by someone other than the person who proposed it.")
  if (parsed.approve) await readStandingSpec(context, row.lot_id)
  const status = parsed.approve ? "approved" : "rejected"
  const { data: claimed, error } = await context.supabase.from("spec_dispositions")
    .update({ status, decided_by: context.userId, decided_at: new Date().toISOString(), decision_note: parsed.note || null })
    .eq("org_id", context.orgId).eq("id", row.id).eq("status", "proposed")
    .select("id").maybeSingle()
  if (error) throw new Error(`Failed to decide the disposition: ${error.message}`)
  if (!claimed) throw new Error("This disposition was already decided or cancelled.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `spec_home.disposition_${status}`, entityType: "spec_disposition", entityId: row.id, payload: { ...dispositionPayload(row), note: parsed.note ?? null } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_disposition", entityId: row.id, before: { status: row.status }, after: { status, note: parsed.note ?? null } }),
  ])
  return { dispositionId: row.id, status }
}

/**
 * Propose the Books write-down a below-cost disposition needs, measured at the
 * disposition price, and link it. The review itself is Books': it needs
 * `books.adjust` to prepare and a different member with `books.close` to approve.
 */
export async function proposeSpecDispositionWriteDown(input: unknown, orgId?: string) {
  const parsed = specDispositionWriteDownSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const row = await readDisposition(context, parsed.dispositionId)
  if (row.status !== "proposed" && row.status !== "approved") throw new Error("This disposition is closed.")
  if (row.price_cents >= row.carrying_cents) throw new Error("The price covers the home's cost in Books; no write-down is needed.")
  if (row.impairment_id) {
    const linked = (await readImpairmentStatuses(context.orgId, [row.impairment_id])).get(row.impairment_id)
    if (linked !== "rejected") throw new Error("This disposition already has a write-down review.")
  }
  const { id: impairmentId } = await proposeInventoryImpairment({
    projectId: row.project_id,
    asOf: today(),
    sellingPriceCents: row.price_cents,
    costToCompleteCents: parsed.costToCompleteCents,
    costToSellCents: parsed.costToSellCents,
    evidenceUrl: parsed.evidenceUrl,
    assumptions: parsed.assumptions,
  })
  const link = context.supabase.from("spec_dispositions").update({ impairment_id: impairmentId }).eq("org_id", context.orgId).eq("id", row.id)
  const { data: linked, error } = await (row.impairment_id ? link.eq("impairment_id", row.impairment_id) : link.is("impairment_id", null)).select("id").maybeSingle()
  if (error) throw new Error(`The write-down was proposed but could not be linked: ${error.message}`)
  if (!linked) throw new Error("The write-down was proposed but the disposition changed; link it again from the disposition.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.disposition_write_down_proposed", entityType: "spec_disposition", entityId: row.id, payload: { ...dispositionPayload(row), impairment_id: impairmentId } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_disposition", entityId: row.id, before: { impairment_id: row.impairment_id }, after: { impairment_id: impairmentId } }),
  ])
  return { dispositionId: row.id, impairmentId }
}

/**
 * Carry out an approved disposition: link the home's open purchase agreement,
 * which must be written to the disposition's buyer at the approved price and
 * priced through this disposition, so the agreement's snapshot carries the
 * disposition's kind. The agreement and its closing are the sale; this only
 * records which sale the disposition was.
 */
export async function executeSpecDisposition(input: unknown, orgId?: string) {
  const parsed = specDispositionReferenceSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const row = await readDisposition(context, parsed.dispositionId)
  const impairmentStatus = row.impairment_id ? (await readImpairmentStatuses(context.orgId, [row.impairment_id])).get(row.impairment_id) ?? null : null
  const blocked = specDispositionExecutionBlock({ status: row.status, priceCents: row.price_cents, carryingCents: row.carrying_cents, impairmentStatus })
  if (blocked) throw new Error(blocked)
  const { data: agreement, error: agreementError } = await context.supabase.from("contracts")
    .select("id, status, buyer_contact_id, total_cents, snapshot")
    .eq("org_id", context.orgId).eq("project_id", row.project_id).eq("contract_type", "purchase_agreement").in("status", ["draft", "active"]).maybeSingle()
  if (agreementError) throw new Error(`Failed to read the home's agreement: ${agreementError.message}`)
  if (!agreement) throw new Error("Write the purchase agreement to the disposition's buyer first; the agreement carries the sale.")
  if (agreement.buyer_contact_id !== row.counterparty_contact_id) throw new Error("The agreement's buyer is not the disposition's buyer.")
  if (Number(agreement.total_cents) !== row.price_cents) throw new Error("The agreement's price is not the approved disposition price.")
  if (agreementDispositionId(agreement.snapshot) !== row.id) throw new Error("The agreement was not priced through this disposition. Void it and write the agreement again so it carries the sale-off.")
  const { data: executed, error } = await context.supabase.from("spec_dispositions")
    .update({ status: "executed", contract_id: agreement.id, executed_by: context.userId, executed_at: new Date().toISOString() })
    .eq("org_id", context.orgId).eq("id", row.id).eq("status", "approved")
    .select("id").maybeSingle()
  if (error) throw new Error(`Failed to carry out the disposition: ${error.message}`)
  if (!executed) throw new Error("This disposition changed while you were carrying it out. Review it and try again.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.disposed", entityType: "spec_disposition", entityId: row.id, payload: { ...dispositionPayload(row), contract_id: agreement.id, impairment_id: row.impairment_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_disposition", entityId: row.id, before: { status: row.status }, after: { status: "executed", contract_id: agreement.id } }),
  ])
  return { dispositionId: row.id, status: "executed" as const, contractId: agreement.id }
}

/** Stop a disposition that has not been carried out; the home returns to retail. */
export async function cancelSpecDisposition(input: unknown, orgId?: string) {
  const parsed = specDispositionReferenceSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const row = await readDisposition(context, parsed.dispositionId)
  const { data: cancelled, error } = await context.supabase.from("spec_dispositions")
    .update({ status: "cancelled", cancelled_by: context.userId, cancelled_at: new Date().toISOString() })
    .eq("org_id", context.orgId).eq("id", row.id).in("status", ["proposed", "approved"])
    .select("id").maybeSingle()
  if (error) throw new Error(`Failed to cancel the disposition: ${error.message}`)
  if (!cancelled) throw new Error("Only a disposition that has not been carried out can be cancelled.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.disposition_cancelled", entityType: "spec_disposition", entityId: row.id, payload: dispositionPayload(row) }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_disposition", entityId: row.id, before: { status: row.status }, after: { status: "cancelled" } }),
  ])
  return { dispositionId: row.id, status: "cancelled" as const }
}

/** The approvals strip shows at most this many of each kind and says when it truncates. */
const APPROVALS_CAP = 25

export type SpecApprovalItem =
  | (SpecPendingChange & { type: "price_change"; lotId: string; lotLabel: string; communityId: string; communityName: string | null; proposedAt: string; reason: string; canDecide: boolean })
  | {
      type: "disposition"
      id: string
      status: "proposed" | "approved"
      lotId: string
      lotLabel: string
      communityId: string
      communityName: string | null
      kind: "bulk_sale" | "investor_sale"
      priceCents: number
      carryingCents: number
      proposedBy: string
      proposedAt: string
      reason: string
      /** A proposed disposition this member may approve or reject. */
      canDecide: boolean
      /** What an approved disposition still waits on, or null when it can be recorded as sold. */
      blockedReason: string | null
      /** An approved disposition whose home has an open agreement to link. */
      hasAgreement: boolean
    }

const embeddedLot = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.object({ lot_number: z.string(), block: z.string().nullable() }).nullable(),
)
const embeddedCommunity = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.object({ name: z.string() }).nullable(),
)
const approvalBase = {
  id: z.string().uuid(),
  lot_id: z.string().uuid(),
  community_id: z.string().uuid(),
  proposed_by: z.string().uuid(),
  proposed_at: z.string(),
  reason: z.string(),
  lot: embeddedLot,
  community: embeddedCommunity,
}
const approvalChangeRowSchema = z.object({
  ...approvalBase,
  kind: z.enum(["price", "incentive"]),
  asking_price_cents: z.coerce.number(),
  from_cents: z.coerce.number(),
  to_cents: z.coerce.number(),
  required_permission: z.string(),
})
const approvalDispositionRowSchema = z.object({
  ...approvalBase,
  project_id: z.string().uuid(),
  kind: z.enum(["bulk_sale", "investor_sale"]),
  status: z.enum(["proposed", "approved"]),
  price_cents: z.coerce.number(),
  carrying_cents: z.coerce.number(),
  impairment_id: z.string().uuid().nullable(),
})

function lotLabelOf(lot: z.infer<typeof embeddedLot>) {
  if (!lot) return "Lot"
  return lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number
}

/**
 * Spec price changes and dispositions waiting on someone, for the Sales desk:
 * moves and dispositions to approve, and approved dispositions waiting on a
 * write-down or their agreement. Read-only: each is acted on by the workbench
 * action (`decideSpecPriceChange`, `decideSpecDisposition`, `executeSpecDisposition`). Scoped by the desk's
 * ambient community or division and by the member's sales scope.
 */
export async function listSpecApprovals(opts: { communityId?: string | null; divisionId?: string | null } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const scopedCommunityIds = await getSalesCommunityIds(context)
  if (scopedCommunityIds && scopedCommunityIds.length === 0) return { items: [] as SpecApprovalItem[], truncated: false }
  let changeQuery = context.supabase.from("spec_price_proposals")
    .select("id, lot_id, community_id, kind, asking_price_cents, from_cents, to_cents, required_permission, proposed_by, proposed_at, reason, lot:lots(lot_number, block), community:communities!inner(name, division_id)", { count: "exact" })
    .eq("org_id", context.orgId).eq("status", "proposed")
  let dispositionQuery = context.supabase.from("spec_dispositions")
    .select("id, lot_id, project_id, community_id, kind, status, price_cents, carrying_cents, impairment_id, proposed_by, proposed_at, reason, lot:lots(lot_number, block), community:communities!inner(name, division_id)", { count: "exact" })
    .eq("org_id", context.orgId).in("status", ["proposed", "approved"])
  if (opts.communityId) {
    changeQuery = changeQuery.eq("community_id", opts.communityId)
    dispositionQuery = dispositionQuery.eq("community_id", opts.communityId)
  }
  if (opts.divisionId) {
    changeQuery = changeQuery.eq("community.division_id", opts.divisionId)
    dispositionQuery = dispositionQuery.eq("community.division_id", opts.divisionId)
  }
  if (scopedCommunityIds) {
    changeQuery = changeQuery.in("community_id", scopedCommunityIds)
    dispositionQuery = dispositionQuery.in("community_id", scopedCommunityIds)
  }
  const [changeResult, dispositionResult, canApproveDisposition] = await Promise.all([
    changeQuery.order("proposed_at", { ascending: true }).limit(APPROVALS_CAP),
    dispositionQuery.order("proposed_at", { ascending: true }).limit(APPROVALS_CAP),
    hasPermission("sales.disposition_approve", context),
  ])
  if (changeResult.error) throw new Error(`Failed to load price approvals: ${changeResult.error.message}`)
  if (dispositionResult.error) throw new Error(`Failed to load dispositions: ${dispositionResult.error.message}`)
  const changes = z.array(approvalChangeRowSchema).parse(changeResult.data ?? [])
  const dispositions = z.array(approvalDispositionRowSchema).parse(dispositionResult.data ?? [])
  const permissions = [...new Set(changes.map((row) => row.required_permission))]
  const approved = dispositions.filter((row) => row.status === "approved")
  const [held, impairmentStatus, agreements] = await Promise.all([
    Promise.all(permissions.map(async (permission) => [permission, await hasPermission(permission, context)] as const)).then((entries) => new Map(entries)),
    readImpairmentStatuses(context.orgId, approved.flatMap((row) => (row.impairment_id ? [row.impairment_id] : []))),
    approved.length
      ? context.supabase.from("contracts").select("project_id").eq("org_id", context.orgId).in("project_id", approved.map((row) => row.project_id)).eq("contract_type", "purchase_agreement").in("status", ["draft", "active"])
      : Promise.resolve({ data: [], error: null }),
  ])
  if (agreements.error) throw new Error(`Failed to read agreements: ${agreements.error.message}`)
  const agreed = new Set((agreements.data ?? []).map((row) => String(row.project_id)))
  const items: SpecApprovalItem[] = [
    ...changes.map((row): SpecApprovalItem => ({
      type: "price_change",
      id: row.id,
      kind: row.kind,
      lotId: row.lot_id,
      lotLabel: lotLabelOf(row.lot),
      communityId: row.community_id,
      communityName: row.community?.name ?? null,
      fromCents: row.from_cents,
      toCents: row.to_cents,
      askingPriceCents: row.asking_price_cents,
      requiredPermission: row.required_permission,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      reason: row.reason,
      canDecide: row.proposed_by !== context.userId && held.get(row.required_permission) === true,
    })),
    ...dispositions.map((row): SpecApprovalItem => ({
      type: "disposition",
      id: row.id,
      status: row.status,
      kind: row.kind,
      lotId: row.lot_id,
      lotLabel: lotLabelOf(row.lot),
      communityId: row.community_id,
      communityName: row.community?.name ?? null,
      priceCents: row.price_cents,
      carryingCents: row.carrying_cents,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      reason: row.reason,
      canDecide: row.status === "proposed" && row.proposed_by !== context.userId && canApproveDisposition,
      blockedReason: row.status === "approved"
        ? specDispositionExecutionBlock({
            status: row.status,
            priceCents: row.price_cents,
            carryingCents: row.carrying_cents,
            impairmentStatus: row.impairment_id ? impairmentStatus.get(row.impairment_id) ?? null : null,
          })
        : null,
      hasAgreement: agreed.has(row.project_id),
    })),
  ].sort((a, b) => a.proposedAt.localeCompare(b.proposedAt))
  const truncated = (changeResult.count ?? 0) > changes.length || (dispositionResult.count ?? 0) > dispositions.length
  return { items, truncated }
}
