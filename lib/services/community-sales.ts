import { composePurchaseAgreementPricing, describeIncentiveIneligibility, evaluateIncentiveEligibility, type PurchaseAgreementPricedItem, type PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { createInvoice } from "@/lib/services/invoices"
import { listCatalog, resolveOptionPricing } from "@/lib/services/option-catalog"
import { instantiateSelectionGroupsForProject } from "@/lib/services/selection-cutoffs"
import { applyCustomerDepositWithContext } from "@/lib/services/books/customer-deposits"
import { projectJournal } from "@/lib/services/books/projector"
import { specInventoryAge } from "@/lib/sales/spec-inventory"
import { z } from "zod"
import type { CommunityPlanAvailabilityDto } from "@/lib/services/house-plans"

const offerPlanSchema = z.object({
  communityId: z.string().uuid(),
  housePlanId: z.string().uuid(),
  basePriceCents: z.number().int().positive(),
  effectiveStart: z.string().date().optional().nullable(),
  effectiveEnd: z.string().date().optional().nullable(),
}).refine(
  (value) => !value.effectiveStart || !value.effectiveEnd || value.effectiveEnd >= value.effectiveStart,
  { message: "Effective end must be on or after effective start", path: ["effectiveEnd"] },
)

const withdrawPlanSchema = z.object({
  communityId: z.string().uuid(),
  housePlanId: z.string().uuid(),
})
import { recordPaymentReversal } from "@/lib/services/payments"
import { getPlanLadder } from "@/lib/services/house-plans"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { createProject } from "@/lib/services/projects"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createDocument } from "@/lib/services/documents"
import { ensureDraftEnvelopeForDocument, replaceEnvelopeRecipients, createEnvelopeSigningRequests } from "@/lib/services/envelopes"
import { createFileRecord } from "@/lib/services/files"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { renderProposalPdf } from "@/lib/pdfs/proposal"
import { buildOrgScopedPath, getFilesStorageProvider, uploadFilesObject } from "@/lib/storage/files-storage"
import { buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { SignatureEmail } from "@/lib/emails/signature-email"
import {
  agreementConfigurationSchema,
  communityBulkRepriceSchema,
  communityPlanPriceSchema,
  createLotHoldSchema,
  createPurchaseAgreementSchema,
  convertReservationSchema,
  incentiveSchema,
  releaseReservationSchema,
  voidPurchaseAgreementSchema,
  type AgreementConfigurationInput,
  type IncentiveInput,
} from "@/lib/validation/community-sales"

const LIVE_RESERVATION_STATUSES = ["hold", "reserved", "converted"]

/**
 * A hold past its expiry no longer blocks a lot, whether or not the sweep has
 * run yet. Reads decide liveness from the data; only the scheduled sweep writes
 * the `expired` status.
 */
function liveReservationOrFilter() {
  return `status.neq.hold,expires_at.is.null,expires_at.gt.${new Date().toISOString()}`
}
/** Lot states a buyer can be sold into — controlled land and closed lots are not. */
const SELLABLE_LOT_STATUSES = ["owned", "developed", "assigned", "started"]

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

async function getSalesDivisionAccess(context: OrgContext) {
  return getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
}

async function assertCommunityInSalesScope(context: OrgContext, communityId: string) {
  const access = await getSalesDivisionAccess(context)
  if (!access.assignedOnly) return
  const { data } = await context.supabase
    .from("communities")
    .select("division_id")
    .eq("org_id", context.orgId)
    .eq("id", communityId)
    .maybeSingle()
  if (!data?.division_id || !access.divisionIds.includes(data.division_id)) {
    throw new Error("Community not found")
  }
}

async function getSalesCommunityIds(context: OrgContext) {
  const access = await getSalesDivisionAccess(context)
  if (!access.assignedOnly) return null
  if (access.divisionIds.length === 0) return []
  const { data, error } = await context.supabase
    .from("communities")
    .select("id")
    .eq("org_id", context.orgId)
    .in("division_id", access.divisionIds)
    .limit(500)
  if (error) throw new Error(`Failed to resolve sales scope: ${error.message}`)
  return (data ?? []).map((community) => community.id as string)
}

/** `createInvoice` takes dollar-denominated `unit_cost` and re-multiplies by 100. */
function invoiceUnitCostFromCents(amountCents: number) {
  return amountCents / 100
}

async function deriveLotAskingPrice(supabase: any, orgId: string, lot: any) {
  if (lot.asking_price_override_cents != null) return Number(lot.asking_price_override_cents)
  let basePrice = 0
  if (lot.house_plan_id) {
    let query = supabase.from("community_plan_availability").select("base_price_cents").eq("org_id", orgId).eq("community_id", lot.community_id).eq("house_plan_id", lot.house_plan_id).eq("is_available", true)
    query = lot.house_plan_elevation_id ? query.eq("elevation_id", lot.house_plan_elevation_id) : query.is("elevation_id", null)
    const { data } = await query.maybeSingle()
    basePrice = Number(data?.base_price_cents ?? 0)
  }
  let structuralOptions = 0
  if (lot.project_id) {
    const { data } = await supabase.from("project_selections").select("price_cents_snapshot, option:selection_options!project_selections_selected_option_id_fkey(option_scope)").eq("org_id", orgId).eq("project_id", lot.project_id).in("status", ["confirmed", "ordered", "received"])
    structuralOptions = (data ?? []).reduce((sum: number, row: any) => {
      const option = Array.isArray(row.option) ? row.option[0] : row.option
      return sum + (option?.option_scope === "structural" ? Number(row.price_cents_snapshot ?? 0) : 0)
    }, 0)
  }
  return basePrice + Number(lot.premium_cents ?? 0) + structuralOptions
}

function reservationDto(row: any) {
  return {
    id: row.id,
    communityId: row.community_id,
    lotId: row.lot_id,
    lotLabel: row.lot?.lot_number ?? null,
    buyerContactId: row.buyer_contact_id,
    buyerName: row.buyer?.full_name ?? null,
    coBuyerContactId: row.co_buyer_contact_id,
    status: row.status,
    expiresAt: row.expires_at,
    askingPriceCents: Number(row.asking_price_cents ?? 0),
    depositRequiredCents: Number(row.deposit_required_cents ?? 0),
    depositInvoiceId: row.deposit_invoice_id,
    contractId: row.contract_id,
    projectId: row.lot?.project_id ?? null,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

const HOLD_SWEEP_BATCH = 200

/**
 * Releases holds whose expiry has passed, across every org.
 *
 * This runs on a schedule rather than as a side effect of somebody opening a
 * sales page: a lot must free itself on time even if no one is looking, and a
 * read request has no business performing a bulk write. Drains in batches so a
 * backlog is never silently capped.
 */
export async function sweepExpiredLotHolds() {
  const service = createServiceSupabaseClient()
  let expired = 0
  for (;;) {
    const nowIso = new Date().toISOString()
    const { data: due, error } = await service
      .from("lot_reservations")
      .select("id")
      .eq("status", "hold")
      .not("expires_at", "is", null)
      .lt("expires_at", nowIso)
      .order("expires_at", { ascending: true })
      .limit(HOLD_SWEEP_BATCH)
    if (error) throw new Error(`Failed to load expired holds: ${error.message}`)
    if (!due?.length) break
    const { data: released, error: releaseError } = await service
      .from("lot_reservations")
      .update({ status: "expired", released_at: nowIso, release_reason: "Hold expired" })
      .in("id", due.map((row) => row.id))
      .eq("status", "hold")
      .select("id, org_id, lot_id, community_id")
    if (releaseError) throw new Error(`Failed to expire stale holds: ${releaseError.message}`)
    const rows = released ?? []
    expired += rows.length
    await Promise.all(rows.map((row) => recordEvent({
      orgId: row.org_id,
      actorId: null,
      eventType: "lot_hold_expired",
      entityType: "lot_reservation",
      entityId: row.id,
      payload: { lot_id: row.lot_id, community_id: row.community_id },
    })))
    if (due.length < HOLD_SWEEP_BATCH) break
  }
  return { expired }
}

/**
 * Sellable inventory. By default this is spec inventory only — started homes
 * with no buyer — which is what the community sales tab wants. Pass
 * `includeToBeBuilt` for the Sales "Find a home" picker, which also needs
 * unstarted lots a buyer can still choose a plan on.
 */
export async function listSpecInventory(opts: {
  communityId?: string
  divisionId?: string
  status?: string
  limit?: number
  includeToBeBuilt?: boolean
} = {}) {
  const context = await requireOrgContext()
  await requirePermission("sales.read", context)
  const divisionAccess = await getSalesDivisionAccess(context)
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) {
    return []
  }
  if (opts.communityId) await assertCommunityInSalesScope(context, opts.communityId)
  let query = context.supabase
    .from("lots")
    .select("id, community_id, division_id, lot_number, block, status, premium_cents, asking_price_override_cents, project_id, house_plan_id, house_plan_elevation_id, project:projects(id, name, start_date, end_date, status), plan:house_plans(name, beds, baths, heated_sqft, total_sqft), community:communities(name)")
    .eq("org_id", context.orgId)
  query = opts.includeToBeBuilt
    ? query.in("status", SELLABLE_LOT_STATUSES)
    : query.not("project_id", "is", null)
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.divisionId) query = query.eq("division_id", opts.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return []
    query = query.in("division_id", divisionAccess.divisionIds)
  }
  if (opts.status) query = query.eq("status", opts.status)
  const { data: lots, error } = await query.order("created_at", { ascending: false }).limit(Math.min(opts.limit ?? 100, 250))
  if (error) throw new Error(`Failed to load spec inventory: ${error.message}`)
  const lotIds = (lots ?? []).map((lot: any) => lot.id)
  const projectIds = (lots ?? []).map((lot: any) => lot.project_id).filter(Boolean)
  const [{ data: reservations }, { data: agreements }] = await Promise.all([
    lotIds.length ? context.supabase.from("lot_reservations").select("lot_id").eq("org_id", context.orgId).in("lot_id", lotIds).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()) : Promise.resolve({ data: [] }),
    projectIds.length ? context.supabase.from("contracts").select("project_id").eq("org_id", context.orgId).in("project_id", projectIds).eq("contract_type", "purchase_agreement").eq("status", "active") : Promise.resolve({ data: [] }),
  ])
  const reserved = new Set((reservations ?? []).map((row: any) => row.lot_id))
  const sold = new Set((agreements ?? []).map((row: any) => row.project_id))
  const availableLots = (lots ?? []).filter((lot: any) => !reserved.has(lot.id) && !sold.has(lot.project_id))
  const communityIds = Array.from(new Set(availableLots.map((lot: any) => lot.community_id))) as string[]
  const planIds = Array.from(new Set(availableLots.map((lot: any) => lot.house_plan_id).filter(Boolean))) as string[]
  const availableProjectIds = availableLots.map((lot: any) => lot.project_id).filter(Boolean) as string[]
  const [{ data: availability }, { data: selections }] = await Promise.all([
    communityIds.length && planIds.length ? context.supabase.from("community_plan_availability").select("community_id, house_plan_id, elevation_id, base_price_cents").eq("org_id", context.orgId).in("community_id", communityIds).in("house_plan_id", planIds).eq("is_available", true) : Promise.resolve({ data: [] }),
    availableProjectIds.length ? context.supabase.from("project_selections").select("project_id, price_cents_snapshot, option:selection_options!project_selections_selected_option_id_fkey(option_scope)").eq("org_id", context.orgId).in("project_id", availableProjectIds).in("status", ["confirmed", "ordered", "received"]) : Promise.resolve({ data: [] }),
  ])
  const structuralByProject = new Map<string, number>()
  for (const row of selections ?? []) {
    const option = Array.isArray((row as any).option) ? (row as any).option[0] : (row as any).option
    if (option?.option_scope === "structural") structuralByProject.set((row as any).project_id, (structuralByProject.get((row as any).project_id) ?? 0) + Number((row as any).price_cents_snapshot ?? 0))
  }
  return availableLots.map((lot: any) => ({
    lotId: lot.id,
    lotLabel: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number,
    communityId: lot.community_id,
    communityName: lot.community?.name ?? null,
    projectId: lot.project_id,
    projectName: lot.project?.name ?? null,
    planLabel: lot.plan?.name ?? "Unassigned plan",
    beds: lot.plan?.beds != null ? Number(lot.plan.beds) : null,
    baths: lot.plan?.baths != null ? Number(lot.plan.baths) : null,
    sqft: lot.plan?.heated_sqft ?? lot.plan?.total_sqft ?? null,
    isSpec: Boolean(lot.project_id),
    status: lot.status,
    startedAt: lot.project?.start_date ?? null,
    ...specInventoryAge(lot.project),
    askingPriceCents: Number(lot.asking_price_override_cents ?? ((availability ?? []).find((row: any) => row.community_id === lot.community_id && row.house_plan_id === lot.house_plan_id && (row.elevation_id ?? null) === (lot.house_plan_elevation_id ?? null))?.base_price_cents ?? 0) + Number(lot.premium_cents ?? 0) + (structuralByProject.get(lot.project_id) ?? 0)),
    premiumCents: Number(lot.premium_cents ?? 0),
  }))
}

/** Sellable lots for the hold flow: owned/developed/assigned/started, no live reservation, not sold. */
export async function listSellableLots(communityId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  const { data: lots, error } = await context.supabase
    .from("lots")
    .select("id, lot_number, status, premium_cents, project_id, plan:house_plans(name)")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .in("status", SELLABLE_LOT_STATUSES)
    .order("lot_number")
    .limit(500)
  if (error) throw new Error(`Failed to list lots: ${error.message}`)
  const lotIds = (lots ?? []).map((lot: any) => lot.id)
  const projectIds = (lots ?? []).map((lot: any) => lot.project_id).filter(Boolean)
  const [{ data: reservations }, { data: agreements }] = await Promise.all([
    lotIds.length ? context.supabase.from("lot_reservations").select("lot_id").eq("org_id", context.orgId).in("lot_id", lotIds).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()) : Promise.resolve({ data: [] }),
    projectIds.length ? context.supabase.from("contracts").select("project_id").eq("org_id", context.orgId).in("project_id", projectIds).eq("contract_type", "purchase_agreement").eq("status", "active") : Promise.resolve({ data: [] }),
  ])
  const reserved = new Set((reservations ?? []).map((row: any) => row.lot_id))
  const sold = new Set((agreements ?? []).map((row: any) => row.project_id))
  return (lots ?? [])
    .filter((lot: any) => !reserved.has(lot.id) && !(lot.project_id && sold.has(lot.project_id)))
    .map((lot: any) => ({
      id: lot.id as string,
      lotNumber: lot.lot_number as string,
      status: lot.status as string,
      premiumCents: Number(lot.premium_cents ?? 0),
      isSpec: Boolean(lot.project_id),
      planLabel: ((Array.isArray(lot.plan) ? lot.plan[0]?.name : lot.plan?.name) ?? null) as string | null,
    }))
}

/**
 * Pipeline-side view of reservations attached to prospects. Powers the production
 * funnel's Reserved/Converted stages and per-row lot chips on the Pipeline page.
 */
export async function listProspectReservations(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const allowedCommunityIds = await getSalesCommunityIds(context)
  if (allowedCommunityIds?.length === 0) return []
  let query = context.supabase
    .from("lot_reservations")
    .select("id, prospect_id, status, asking_price_cents, expires_at, community_id, lot:lots(lot_number, project_id), community:communities(name)")
    .eq("org_id", context.orgId)
    .not("prospect_id", "is", null)
    .in("status", LIVE_RESERVATION_STATUSES)
    .or(liveReservationOrFilter())
    .order("created_at", { ascending: false })
    .limit(1000)
  if (allowedCommunityIds) query = query.in("community_id", allowedCommunityIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list prospect reservations: ${error.message}`)
  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    prospectId: row.prospect_id as string,
    status: row.status as "hold" | "reserved" | "converted",
    askingPriceCents: Number(row.asking_price_cents ?? 0),
    expiresAt: (row.expires_at ?? null) as string | null,
    communityId: row.community_id as string,
    communityName: ((Array.isArray(row.community) ? row.community[0]?.name : row.community?.name) ?? null) as string | null,
    lotLabel: ((Array.isArray(row.lot) ? row.lot[0]?.lot_number : row.lot?.lot_number) ?? null) as string | null,
    projectId: ((Array.isArray(row.lot) ? row.lot[0]?.project_id : row.lot?.project_id) ?? null) as string | null,
  }))
}

/**
 * The Pipeline → Sales baton pass: hold a lot for a prospect. Promotes the prospect's
 * primary contact into the directory (conversions.ts pattern) so the reservation has a
 * real buyer contact, stamps the prospect's community, then rides createLotHold.
 */
export async function createLotHoldFromProspect(input: { prospectId: string; lotId: string; expiresAt: string; notes?: string | null }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: prospect, error } = await context.supabase
    .from("prospects")
    .select("id, name, status, community_id")
    .eq("org_id", context.orgId)
    .eq("id", input.prospectId)
    .maybeSingle()
  if (error || !prospect) throw new Error("Prospect not found")
  if (["won", "lost"].includes(prospect.status)) throw new Error("This prospect is already closed")
  const { data: prospectContacts } = await context.supabase
    .from("prospect_contacts")
    .select("id, full_name, email, phone, role, is_primary, promoted_contact_id")
    .eq("org_id", context.orgId)
    .eq("prospect_id", prospect.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
  const primary = (prospectContacts ?? [])[0]
  if (!primary) throw new Error("Add a contact to this prospect before holding a lot")
  let buyerContactId = primary.promoted_contact_id as string | null
  if (!buyerContactId && primary.email) {
    const { data: existing } = await context.supabase.from("contacts").select("id").eq("org_id", context.orgId).eq("email", primary.email).maybeSingle()
    buyerContactId = existing?.id ?? null
  }
  if (!buyerContactId) {
    const { createContact } = await import("@/lib/services/contacts")
    const contact = await createContact({
      input: { full_name: primary.full_name, email: primary.email || undefined, phone: primary.phone || undefined, role: primary.role || undefined, contact_type: "client" },
      orgId: context.orgId,
    })
    buyerContactId = contact.id
  }
  await context.supabase.from("prospect_contacts").update({ promoted_contact_id: buyerContactId, updated_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", primary.id)
  const reservation = await createLotHold({ lotId: input.lotId, buyerContactId, prospectId: prospect.id, expiresAt: input.expiresAt, notes: input.notes ?? undefined }, context.orgId)
  if (prospect.community_id !== reservation.communityId) {
    await context.supabase.from("prospects").update({ community_id: reservation.communityId, updated_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", prospect.id)
  }
  return reservation
}

export async function createLotHold(input: unknown, orgId?: string) {
  const parsed = createLotHoldSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: lot, error } = await context.supabase.from("lots").select("id, community_id, status, premium_cents, asking_price_override_cents, project_id, house_plan_id, house_plan_elevation_id").eq("org_id", context.orgId).eq("id", parsed.lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  if (!["owned", "developed", "assigned", "started"].includes(lot.status)) throw new Error("This lot is not sellable")
  const { data, error: insertError } = await context.supabase.from("lot_reservations").insert({
    org_id: context.orgId, community_id: lot.community_id, lot_id: lot.id,
    buyer_contact_id: parsed.buyerContactId, co_buyer_contact_id: parsed.coBuyerContactId ?? null,
    prospect_id: parsed.prospectId ?? null, status: "hold", expires_at: parsed.expiresAt,
    asking_price_cents: await deriveLotAskingPrice(context.supabase, context.orgId, lot), notes: parsed.notes ?? null,
    created_by: context.userId,
  }).select("*, lot:lots(lot_number, project_id), buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name)").single()
  if (insertError || !data) throw new Error(insertError?.code === "23505" ? "This lot already has a live reservation" : `Failed to hold lot: ${insertError?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_hold_created", entityType: "lot_reservation", entityId: data.id, payload: { lot_id: lot.id, community_id: lot.community_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "lot_reservation", entityId: data.id, after: data }),
  ])
  return reservationDto(data)
}

export async function convertHoldToReservation(input: unknown, orgId?: string) {
  const parsed = convertReservationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: reservation } = await context.supabase.from("lot_reservations").select("*, lot:lots(*)").eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
  if (!reservation || reservation.status !== "hold") throw new Error("Active lot hold not found")
  let projectId = reservation.lot.project_id as string | null
  if (!projectId) {
    const project = await createProject({ input: { name: parsed.projectName ?? `Lot ${reservation.lot.lot_number}`, property_type: "production", status: "planning", client_id: reservation.buyer_contact_id, prospect_id: reservation.prospect_id ?? null }, orgId: context.orgId, context, authorizationPermission: "sales.manage" })
    projectId = project.id
    await context.supabase.from("lots").update({ project_id: projectId, status: "assigned" }).eq("org_id", context.orgId).eq("id", reservation.lot_id)
  } else {
    await context.supabase.from("projects").update({ client_id: reservation.buyer_contact_id }).eq("org_id", context.orgId).eq("id", projectId)
  }
  let invoiceId: string | null = null
  if (parsed.depositCents > 0) {
    const invoice = await createInvoice({ input: {
      project_id: projectId, invoice_number: `DEP-${Date.now().toString().slice(-9)}`, title: "Earnest deposit",
      issue: true, issue_date: new Date().toISOString().slice(0, 10), due_date: new Date().toISOString().slice(0, 10),
      tax_rate: 0, customer_id: reservation.buyer_contact_id, lines: [{ description: "Earnest deposit", quantity: 1, unit: "deposit", unit_cost: invoiceUnitCostFromCents(parsed.depositCents), taxable: false }],
      metadata: { invoice_kind: "earnest_deposit", source_reservation_id: reservation.id },
    }, orgId: context.orgId, context, authorizationPermission: "sales.manage", sendAuthorizationPermission: "sales.manage" })
    invoiceId = invoice.id
  }
  const { data, error } = await context.supabase.from("lot_reservations").update({ status: "reserved", deposit_required_cents: parsed.depositCents, deposit_invoice_id: invoiceId }).eq("org_id", context.orgId).eq("id", reservation.id).select("*, lot:lots(lot_number, project_id), buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name)").single()
  if (error || !data) throw new Error(`Failed to reserve lot: ${error?.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_reserved", entityType: "lot_reservation", entityId: data.id, payload: { project_id: projectId, deposit_invoice_id: invoiceId } })
  return reservationDto(data)
}

/**
 * A forfeited deposit stops being the buyer's money and becomes the builder's
 * income. Recording only a metadata label would leave the receipt sitting as a
 * customer-deposit liability forever, so bill the forfeiture and apply the
 * deposit to it: the liability clears and the revenue posts.
 */
async function forfeitReservationDeposit(
  context: OrgServiceContext,
  reservation: { id: string; deposit_invoice_id: string; buyer_contact_id: string | null; lot: { project_id: string | null } | { project_id: string | null }[] | null },
  reason: string,
) {
  const { data: payments, error } = await context.supabase
    .from("payments")
    .select("id, amount_cents, metadata")
    .eq("org_id", context.orgId)
    .eq("invoice_id", reservation.deposit_invoice_id)
    .in("status", ["succeeded", "completed"])
  if (error) throw new Error(`Failed to load deposit payments: ${error.message}`)
  const collected = (payments ?? []).filter((payment) => !(payment.metadata as Record<string, unknown> | null)?.customer_deposit_application)
  const forfeitedCents = collected.reduce((sum, payment) => sum + Number(payment.amount_cents ?? 0), 0)
  if (forfeitedCents <= 0) return
  const lot = Array.isArray(reservation.lot) ? reservation.lot[0] : reservation.lot
  const projectId = lot?.project_id
  if (!projectId) throw new Error("A forfeited deposit needs the reservation's project to post against")
  const today = new Date().toISOString().slice(0, 10)
  const invoice = await createInvoice({ input: {
    project_id: projectId, invoice_number: `FORFEIT-${Date.now().toString().slice(-9)}`, title: "Forfeited earnest deposit",
    issue: false, issue_date: today, due_date: today, tax_rate: 0,
    customer_id: reservation.buyer_contact_id ?? null,
    lines: [{ description: `Forfeited earnest deposit — ${reason}`, quantity: 1, unit: "deposit", unit_cost: invoiceUnitCostFromCents(forfeitedCents), taxable: false }],
    metadata: { invoice_kind: "deposit_forfeiture", source_reservation_id: reservation.id },
  }, orgId: context.orgId, context, authorizationPermission: "sales.manage", sendAuthorizationPermission: "sales.manage" })
  for (const payment of collected) {
    await applyCustomerDepositWithContext(context, { depositPaymentId: payment.id, targetInvoiceId: invoice.id, amountCents: Number(payment.amount_cents), appliedAt: new Date().toISOString() })
  }
  await projectJournal(context.orgId, { full: false })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "deposit_forfeited", entityType: "lot_reservation", entityId: reservation.id, payload: { amount_cents: forfeitedCents, invoice_id: invoice.id } })
}

export async function releaseReservation(input: unknown, orgId?: string) {
  const parsed = releaseReservationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: reservation } = await context.supabase.from("lot_reservations").select("*, lot:lots(project_id, status)").eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
  if (!reservation || !["hold", "reserved", "converted"].includes(reservation.status)) throw new Error("Live reservation not found")
  if (parsed.depositDisposition === "refund" && reservation.deposit_invoice_id) {
    await requirePermission("payment.release", context)
    const { data: payments } = await context.supabase.from("payments").select("id, amount_cents").eq("org_id", context.orgId).eq("invoice_id", reservation.deposit_invoice_id).eq("status", "succeeded")
    for (const payment of payments ?? []) await recordPaymentReversal({ paymentId: payment.id, amountCents: Number(payment.amount_cents), reversalType: "refund", reason: parsed.reason, metadata: { source_reservation_id: reservation.id }, orgId: context.orgId })
  }
  if (parsed.depositDisposition === "forfeit" && reservation.deposit_invoice_id) {
    await requirePermission("payment.release", context)
    await forfeitReservationDeposit(context, reservation, parsed.reason)
  }
  const metadata = { ...(reservation.metadata ?? {}), deposit_disposition: parsed.depositDisposition ?? null }
  const { data, error } = await context.supabase.from("lot_reservations").update({ status: "released", released_at: new Date().toISOString(), release_reason: parsed.reason, metadata }).eq("org_id", context.orgId).eq("id", reservation.id).select("*, lot:lots(lot_number, project_id), buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name)").single()
  if (error || !data) throw new Error(`Failed to release reservation: ${error?.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_reservation_released", entityType: "lot_reservation", entityId: data.id, payload: { reason: parsed.reason, deposit_disposition: parsed.depositDisposition } })
  return reservationDto(data)
}

/**
 * A community rarely exceeds a few hundred lots, but the sheet's premium range
 * and per-plan velocity are both read off every lot in it — so the read is
 * capped, and `lotsTruncated` says so rather than quietly narrowing the range.
 */
const PRICE_SHEET_LOT_CAP = 5_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

export async function getCommunityPriceSheet(communityId: string, opts: { onDate?: string } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  const onDate = opts.onDate ?? new Date().toISOString().slice(0, 10)
  const [{ data: availability, error }, { data: lots }, { data: community }, { data: libraryPlans }, incentives] = await Promise.all([
    context.supabase.from("community_plan_availability").select("id, base_price_cents, elevation_id, metadata, plan:house_plans(id, name, code, beds, baths, heated_sqft, stories, garage_bays), elevation:house_plan_elevations(name, code)").eq("org_id", context.orgId).eq("community_id", communityId).eq("is_available", true).or(`effective_start.is.null,effective_start.lte.${onDate}`).or(`effective_end.is.null,effective_end.gte.${onDate}`),
    // One read of the lots answers three questions: what premiums the sheet's
    // "from" price spans, which plans are actually moving, and what a lot here
    // costs — the denominator under any margin the sheet reports.
    context.supabase.from("lots").select("status, house_plan_id, premium_cents, cost_basis_cents").eq("org_id", context.orgId).eq("community_id", communityId).limit(PRICE_SHEET_LOT_CAP),
    context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", communityId).maybeSingle(),
    // How much of the library this community actually sells. An offering that is
    // four of eleven plans is a decision; it used to be invisible.
    context.supabase.from("house_plans").select("id, division_id").eq("org_id", context.orgId).eq("status", "active").limit(500),
    listIncentives({ communityId, status: "active", eligibleOnly: true }, context.orgId),
  ])
  if (error) throw new Error(`Failed to load price sheet: ${error.message}`)

  type LotRow = { status: string; house_plan_id: string | null; premium_cents: number | null; cost_basis_cents: number | null }
  const lotRows = (lots ?? []) as LotRow[]
  const premiums = lotRows
    .filter((lot) => ["owned", "developed", "assigned"].includes(lot.status))
    .map((lot) => Number(lot.premium_cents ?? 0))
  const minPremium = premiums.length ? Math.min(...premiums) : 0
  const maxPremium = premiums.length ? Math.max(...premiums) : 0

  const velocity = new Map<string, { sold: number; building: number }>()
  for (const lot of lotRows) {
    if (!lot.house_plan_id) continue
    const entry = velocity.get(lot.house_plan_id) ?? { sold: 0, building: 0 }
    if (lot.status === "closed") entry.sold += 1
    else if (lot.status === "assigned" || lot.status === "started") entry.building += 1
    velocity.set(lot.house_plan_id, entry)
  }

  const divisionId = (community?.division_id ?? null) as string | null
  const libraryPlanCount = (libraryPlans ?? []).filter(
    (plan: { division_id: string | null }) => plan.division_id == null || plan.division_id === divisionId,
  ).length

  return {
    asOfDate: onDate,
    minPremiumCents: minPremium,
    maxPremiumCents: maxPremium,
    /** Median cost basis of a lot here — half of what a house on it has to cover. */
    lotBasisCents: median(lotRows.map((lot) => Number(lot.cost_basis_cents ?? 0)).filter((value) => value > 0)),
    libraryPlanCount,
    lotsTruncated: lotRows.length >= PRICE_SHEET_LOT_CAP,
    incentives,
    rows: (availability ?? []).map((row: any) => {
      const metadata = (row.metadata ?? {}) as { repriced_at?: string | null; previous_base_price_cents?: number | null }
      const counts = velocity.get(row.plan?.id) ?? { sold: 0, building: 0 }
      return { availabilityId: row.id, planId: row.plan?.id, planName: row.plan?.name, planCode: row.plan?.code, elevationId: row.elevation_id, elevationName: row.elevation?.name ?? row.elevation?.code ?? "Standard", basePriceCents: Number(row.base_price_cents), fromPriceCents: Number(row.base_price_cents) + minPremium, beds: row.plan?.beds, baths: row.plan?.baths, sqft: row.plan?.heated_sqft, stories: row.plan?.stories ?? null, garageBays: row.plan?.garage_bays ?? null, repricedAt: metadata.repriced_at ?? null, previousBasePriceCents: metadata.previous_base_price_cents == null ? null : Number(metadata.previous_base_price_cents), soldCount: counts.sold, buildingCount: counts.building }
    }),
  }
}

export type CommunityOfferingCosts = {
  /** Median lot cost basis in this community. */
  lotBasisCents: number | null
  /** Direct construction cost of each offered plan's released edition. */
  buildCostByPlanId: Record<string, number>
}

/**
 * What the offered plans cost to build, so the price sheet can say what a price
 * is worth rather than only what it is. A sales manager repricing without the
 * margin under the number is guessing, and the give from incentives lands on the
 * same line.
 *
 * Null — and the sheet simply drops its margin column — when the reader cannot
 * see executive numbers or the plan library. Margin is gated on `report.read`,
 * the same permission the community header's margin stat answers to.
 */
export async function getCommunityOfferingCosts(
  communityId: string,
  orgId?: string,
): Promise<CommunityOfferingCosts | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  const [canReadMargin, canReadPlans] = await Promise.all([
    hasPermission("report.read", context),
    hasPermission("plan.read", context),
  ])
  if (!canReadMargin || !canReadPlans) return null

  const [ladder, { data: lots, error }] = await Promise.all([
    getPlanLadder({ communityId }, context.orgId),
    context.supabase
      .from("lots")
      .select("cost_basis_cents")
      .eq("org_id", context.orgId)
      .eq("community_id", communityId)
      .gt("cost_basis_cents", 0)
      .limit(PRICE_SHEET_LOT_CAP),
  ])
  if (error) throw new Error(`Failed to load lot basis: ${error.message}`)

  const buildCostByPlanId: Record<string, number> = {}
  for (const rung of ladder.rungs) {
    if (rung.released_cost_cents != null) buildCostByPlanId[rung.id] = rung.released_cost_cents
  }
  return {
    lotBasisCents: median((lots ?? []).map((lot: { cost_basis_cents: number | null }) => Number(lot.cost_basis_cents ?? 0))),
    buildCostByPlanId,
  }
}

/**
 * What the price was and when it moved, carried in the row's own metadata. A
 * sales manager reprices against the last move, not against nothing, and the
 * price sheet had no memory of one. JSONB-backed so this needs no migration.
 */
function repriceMetadata(before: { base_price_cents?: number | null; metadata?: unknown } | null) {
  const metadata = (before?.metadata ?? {}) as Record<string, unknown>
  return {
    ...metadata,
    repriced_at: new Date().toISOString(),
    previous_base_price_cents: before?.base_price_cents == null ? null : Number(before.base_price_cents),
  }
}

/**
 * Repricing a whole sheet by a percentage or a flat amount — the move a sales
 * manager actually makes at a release, which used to be one keystroke-by-
 * keystroke edit per plan with no way to see the result first.
 */
export async function bulkRepriceCommunityPlans(input: unknown, orgId?: string) {
  const parsed = communityBulkRepriceSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await assertCommunityInSalesScope(context, parsed.communityId)

  const { data: rows, error } = await context.supabase
    .from("community_plan_availability")
    .select("id, base_price_cents, metadata, house_plan_id, elevation_id")
    .eq("org_id", context.orgId)
    .eq("community_id", parsed.communityId)
    .in("id", parsed.availabilityIds)
  if (error) throw new Error(`Failed to load the price sheet: ${error.message}`)
  if ((rows ?? []).length !== parsed.availabilityIds.length) throw new Error("One or more plans were not found on this price sheet.")

  let repriced = 0
  for (const row of rows ?? []) {
    const current = Number(row.base_price_cents)
    const next = Math.max(
      0,
      Math.round(parsed.mode === "percent" ? current * (1 + parsed.value / 100) : current + parsed.value),
    )
    if (next === current) continue
    const { error: updateError } = await context.supabase
      .from("community_plan_availability")
      .update({ base_price_cents: next, metadata: repriceMetadata(row) })
      .eq("org_id", context.orgId)
      .eq("id", row.id)
    if (updateError) throw new Error(`Failed to reprice: ${updateError.message}`)
    repriced += 1
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_availability.repriced", entityType: "house_plan", entityId: row.house_plan_id, payload: { community_id: parsed.communityId, elevation_id: row.elevation_id, base_price_cents: next, bulk: true } })
  }
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community", entityId: parsed.communityId, after: { repriced, mode: parsed.mode, value: parsed.value } })
  return { repriced }
}

/**
 * The base price a plan sells for in one community. Plans decides *which* plans
 * are offered where; this decides what they cost there, because repricing is the
 * sales manager's weekly edit and not an estimating change. `setCommunityAvailability`
 * on the plan side sets the launch price and never touches it again.
 */
/**
 * Puts a plan into, or takes it out of, this community's offering.
 *
 * The plan library owns the *product*; whether a community sells it, and for
 * what, is the sales manager's call — so this lives here under `sales.manage`
 * rather than in the plan library under `plan.write`. It used to be mutable
 * from both, with a rule that silently ignored a price passed by the plan-side
 * caller to stop the two from fighting. One home per mutation removes the need
 * for the rule: the launch price you type here is the price that lands.
 */
export async function offerPlanInCommunity(input: unknown, orgId?: string): Promise<CommunityPlanAvailabilityDto[]> {
  const parsed = offerPlanSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await assertCommunityInSalesScope(context, parsed.communityId)
  const { data: plan, error: planError } = await context.supabase
    .from("house_plans")
    .select("id, versions:house_plan_versions(id, status), elevations:house_plan_elevations(id, is_active)")
    .eq("org_id", context.orgId).eq("id", parsed.housePlanId).maybeSingle()
  if (planError || !plan) throw new Error("Plan not found")
  const versions = Array.isArray(plan.versions) ? plan.versions : []
  if (!versions.some((version: { status: string }) => version.status === "released")) {
    throw new Error("A plan needs a released version before a community can sell it")
  }
  // The server owns which elevations get a row, so a stale client cannot offer
  // a retired elevation or miss a new one.
  const elevationIds = (Array.isArray(plan.elevations) ? plan.elevations : [])
    .filter((elevation: { is_active: boolean }) => elevation.is_active)
    .map((elevation: { id: string }) => elevation.id as string)
  const rows = [null, ...elevationIds].map((elevationId) => ({
    org_id: context.orgId,
    community_id: parsed.communityId,
    house_plan_id: parsed.housePlanId,
    elevation_id: elevationId,
    is_available: true,
    base_price_cents: parsed.basePriceCents,
    effective_start: parsed.effectiveStart ?? null,
    effective_end: parsed.effectiveEnd ?? null,
  }))
  const { data, error } = await context.supabase.from("community_plan_availability")
    .upsert(rows, { onConflict: "community_id,house_plan_id,elevation_id" })
    .select("id, community_id, house_plan_id, elevation_id, is_available, base_price_cents, effective_start, effective_end")
  if (error) throw new Error(`Failed to offer the plan: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_offered", entityType: "community", entityId: parsed.communityId, payload: { house_plan_id: parsed.housePlanId, base_price_cents: parsed.basePriceCents, row_count: rows.length } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community", entityId: parsed.communityId, after: { offered: parsed.housePlanId, availability: data ?? [] } }),
  ])
  return (data ?? []).map((row) => ({ ...row, base_price_cents: Number(row.base_price_cents) }))
}

/** Stops a community selling a plan. Lots already carrying it are untouched. */
export async function withdrawPlanFromCommunity(input: unknown, orgId?: string) {
  const parsed = withdrawPlanSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await assertCommunityInSalesScope(context, parsed.communityId)
  const { data, error } = await context.supabase.from("community_plan_availability")
    .update({ is_available: false })
    .eq("org_id", context.orgId).eq("community_id", parsed.communityId).eq("house_plan_id", parsed.housePlanId)
    .select("id")
  if (error) throw new Error(`Failed to withdraw the plan: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_withdrawn", entityType: "community", entityId: parsed.communityId, payload: { house_plan_id: parsed.housePlanId, row_count: (data ?? []).length } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community", entityId: parsed.communityId, before: { offered: parsed.housePlanId } }),
  ])
  return { withdrawn: (data ?? []).length }
}

/** Released plans this community could sell but is not offering yet. */
export async function listOfferablePlans(communityId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  const [{ data: offered, error: offeredError }, { data: plans, error: plansError }] = await Promise.all([
    context.supabase.from("community_plan_availability").select("house_plan_id").eq("org_id", context.orgId).eq("community_id", communityId).eq("is_available", true),
    context.supabase.from("house_plans").select("id, code, name, versions:house_plan_versions(id, status), elevations:house_plan_elevations(id, name, code, is_active)").eq("org_id", context.orgId).eq("is_archived", false).order("code").limit(500),
  ])
  if (offeredError || plansError) throw new Error(`Failed to load offerable plans: ${(offeredError ?? plansError)?.message}`)
  const offeredIds = new Set((offered ?? []).map((row) => row.house_plan_id))
  return (plans ?? [])
    .filter((plan) => !offeredIds.has(plan.id))
    // Only a released plan version can be sold — an unreleased plan has no
    // priced takeoff behind it, so offering it would promise an unbuildable home.
    .filter((plan) => (Array.isArray(plan.versions) ? plan.versions : []).some((version: { status: string }) => version.status === "released"))
    .map((plan) => ({
      id: plan.id,
      code: plan.code as string | null,
      name: plan.name as string,
      elevationIds: (Array.isArray(plan.elevations) ? plan.elevations : []).filter((elevation: { is_active: boolean }) => elevation.is_active).map((elevation: { id: string }) => elevation.id),
    }))
}

export async function setCommunityPlanPrice(input: unknown, orgId?: string) {
  const parsed = communityPlanPriceSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await assertCommunityInSalesScope(context, parsed.communityId)
  const { data: before } = await context.supabase
    .from("community_plan_availability")
    .select("base_price_cents, metadata")
    .eq("org_id", context.orgId)
    .eq("id", parsed.availabilityId)
    .eq("community_id", parsed.communityId)
    .maybeSingle()
  const { data, error } = await context.supabase
    .from("community_plan_availability")
    .update({ base_price_cents: parsed.basePriceCents, metadata: repriceMetadata(before) })
    .eq("org_id", context.orgId)
    .eq("id", parsed.availabilityId)
    .eq("community_id", parsed.communityId)
    .select("id, community_id, house_plan_id, elevation_id, base_price_cents")
    .maybeSingle()
  if (error || !data) throw new Error(`Failed to update base price: ${error?.message ?? "price sheet row not found"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_availability.repriced", entityType: "house_plan", entityId: data.house_plan_id, payload: { community_id: data.community_id, elevation_id: data.elevation_id, base_price_cents: parsed.basePriceCents } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community_plan_availability", entityId: data.id, after: data }),
  ])
  return { ...data, base_price_cents: Number(data.base_price_cents) }
}

export async function listIncentives(opts: { communityId?: string; status?: string; eligibleOnly?: boolean } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  if (opts.communityId) await assertCommunityInSalesScope(context, opts.communityId)
  const allowedCommunityIds = opts.communityId ? null : await getSalesCommunityIds(context)
  let query = context.supabase.from("incentives").select("*").eq("org_id", context.orgId)
  if (opts.communityId) query = query.or(`community_id.is.null,community_id.eq.${opts.communityId}`)
  else if (allowedCommunityIds) {
    query = allowedCommunityIds.length > 0
      ? query.or(`community_id.is.null,community_id.in.(${allowedCommunityIds.join(",")})`)
      : query.is("community_id", null)
  }
  if (opts.status) query = query.eq("status", opts.status)
  const { data, error } = await query.order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load incentives: ${error.message}`)
  const rows = data ?? []
  // Only metered incentives need a usage count, and counting scans agreements —
  // so do not pay for it on the common unmetered ones.
  const meteredIds = rows.filter((row) => typeof row.max_uses === "number" && row.max_uses > 0).map((row) => row.id)
  const uses = meteredIds.length ? await countIncentiveUses(context, meteredIds) : new Map<string, number>()
  const today = new Date().toISOString().slice(0, 10)
  const annotated = rows.map((row) => {
    const usedCount = uses.get(row.id) ?? 0
    const verdict = evaluateIncentiveEligibility(
      { status: row.status, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, maxUses: row.max_uses, requiresApproval: row.requires_approval, approvedAt: incentiveApprovedAt(row) },
      today,
      usedCount,
    )
    return { ...row, used_count: usedCount, approved_at: incentiveApprovedAt(row), eligible: verdict.eligible, ineligible_reason: verdict.reason }
  })
  return opts.eligibleOnly ? annotated.filter((row) => row.eligible) : annotated
}

export async function upsertIncentive(input: IncentiveInput, orgId?: string) {
  const parsed = incentiveSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const payload = { org_id: context.orgId, community_id: parsed.communityId ?? null, name: parsed.name, incentive_type: parsed.incentiveType, amount_cents: parsed.amountCents ?? null, percent: parsed.percent ?? null, applies_to: parsed.appliesTo, status: parsed.status, effective_start: parsed.effectiveStart ?? null, effective_end: parsed.effectiveEnd ?? null, max_uses: parsed.maxUses ?? null, requires_approval: parsed.requiresApproval, notes: parsed.notes ?? null, created_by: context.userId }
  const result = parsed.id ? await context.supabase.from("incentives").update(payload).eq("org_id", context.orgId).eq("id", parsed.id).select("*").single() : await context.supabase.from("incentives").insert(payload).select("*").single()
  if (result.error || !result.data) throw new Error(`Failed to save incentive: ${result.error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: parsed.id ? "update" : "insert", entityType: "incentive", entityId: result.data.id, after: result.data })
  return result.data
}

/**
 * Counts executed agreements already carrying each incentive, so `max_uses`
 * means something. Usage lives in the agreement's pricing snapshot rather than
 * a counter column, which keeps the count honest if an agreement is voided.
 */
async function countIncentiveUses(context: OrgServiceContext, incentiveIds: string[]) {
  const counts = new Map<string, number>()
  await Promise.all(incentiveIds.map(async (incentiveId) => {
    const { count, error } = await context.supabase
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("contract_type", "purchase_agreement")
      .eq("status", "active")
      .contains("snapshot", { purchase_agreement: { pricing: { incentives: [{ incentiveId }] } } })
    if (error) throw new Error(`Failed to count incentive usage: ${error.message}`)
    counts.set(incentiveId, count ?? 0)
  }))
  return counts
}

function incentiveApprovedAt(row: { metadata?: unknown }) {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>
  return typeof metadata.approved_at === "string" ? metadata.approved_at : null
}

export async function approveIncentive(id: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: before } = await context.supabase.from("incentives").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (!before) throw new Error("Incentive not found")
  const metadata = { ...((before.metadata ?? {}) as Record<string, unknown>), approved_at: new Date().toISOString(), approved_by: context.userId }
  const { data, error } = await context.supabase.from("incentives").update({ metadata }).eq("org_id", context.orgId).eq("id", id).select("*").single()
  if (error || !data) throw new Error(`Failed to approve incentive: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "incentive_approved", entityType: "incentive", entityId: data.id, payload: { community_id: data.community_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "incentive", entityId: data.id, before, after: data }),
  ])
  return data
}

export async function endIncentive(id: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { error } = await context.supabase.from("incentives").update({ status: "ended", effective_end: new Date().toISOString().slice(0, 10) }).eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to end incentive: ${error.message}`)
}

export async function priceAgreementDraft(input: AgreementConfigurationInput, orgId?: string) {
  const parsed = agreementConfigurationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: lot, error } = await context.supabase.from("lots").select("id, community_id, project_id, premium_cents, house_plan_id, house_plan_version_id, house_plan_elevation_id, swing, plan:house_plans(name), elevation:house_plan_elevations(name, code)").eq("org_id", context.orgId).eq("id", parsed.lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  const versionId = parsed.housePlanVersionId ?? lot.house_plan_version_id
  if (!versionId) throw new Error("Choose a released plan version")
  if (lot.project_id && lot.house_plan_version_id && parsed.housePlanVersionId && parsed.housePlanVersionId !== lot.house_plan_version_id) throw new Error("A spec home's pinned plan version cannot be changed")
  if (parsed.swing && lot.swing !== "either" && parsed.swing !== lot.swing) throw new Error(`This lot only supports a ${lot.swing}-swing plan`)
  const { data: version } = await context.supabase.from("house_plan_versions").select("id, house_plan_id, status, label, plan:house_plans(name)").eq("org_id", context.orgId).eq("id", versionId).maybeSingle()
  if (!version || version.status !== "released") throw new Error("The selected plan version is not released")
  const elevationId = parsed.elevationId ?? lot.house_plan_elevation_id ?? null
  let availabilityQuery = context.supabase.from("community_plan_availability").select("base_price_cents").eq("org_id", context.orgId).eq("community_id", lot.community_id).eq("house_plan_id", version.house_plan_id).eq("is_available", true)
  availabilityQuery = elevationId ? availabilityQuery.eq("elevation_id", elevationId) : availabilityQuery.is("elevation_id", null)
  const { data: availability } = await availabilityQuery.maybeSingle()
  if (!availability) throw new Error("This plan and elevation are not available in the community")
  const resolved = await resolveOptionPricing({ orgId: context.orgId, items: parsed.optionItems, housePlanVersionId: versionId, communityId: lot.community_id })
  if (resolved.some((item) => !item.available)) throw new Error("One or more configured options are unavailable")
  const optionIds = resolved.map((item) => item.optionId).filter(Boolean) as string[]
  const packageIds = resolved.map((item) => item.packageId).filter(Boolean) as string[]
  const [{ data: options }, { data: packages }, { data: incentiveRows }] = await Promise.all([
    optionIds.length ? context.supabase.from("selection_options").select("id, name, option_scope, category:selection_categories(name)").eq("org_id", context.orgId).in("id", optionIds) : Promise.resolve({ data: [] }),
    packageIds.length ? context.supabase.from("selection_packages").select("id, name").eq("org_id", context.orgId).in("id", packageIds) : Promise.resolve({ data: [] }),
    parsed.incentiveIds.length ? context.supabase.from("incentives").select("*").eq("org_id", context.orgId).in("id", parsed.incentiveIds) : Promise.resolve({ data: [] }),
  ])
  const requestedIncentives = incentiveRows ?? []
  if (requestedIncentives.length !== parsed.incentiveIds.length) throw new Error("One or more incentives could not be found")
  const incentiveUses = await countIncentiveUses(context, parsed.incentiveIds)
  const today = new Date().toISOString().slice(0, 10)
  for (const row of requestedIncentives) {
    const verdict = evaluateIncentiveEligibility(
      { status: row.status, effectiveStart: row.effective_start, effectiveEnd: row.effective_end, maxUses: row.max_uses, requiresApproval: row.requires_approval, approvedAt: incentiveApprovedAt(row) },
      today,
      incentiveUses.get(row.id) ?? 0,
    )
    if (!verdict.eligible && verdict.reason) throw new Error(`Incentive "${row.name}" ${describeIncentiveIneligibility(verdict.reason)}`)
  }
  const priced: PurchaseAgreementPricedItem[] = resolved.map((item: any) => {
    const option = (options ?? []).find((row: any) => row.id === item.optionId)
    const selectionPackage = (packages ?? []).find((row: any) => row.id === item.packageId)
    const category = Array.isArray(option?.category) ? option.category[0] : option?.category
    return { optionId: item.optionId, packageId: item.packageId, label: option?.name ?? selectionPackage?.name ?? "Option", category: category?.name ?? null, priceCents: item.priceCents, source: item.source, scope: option?.option_scope } as PurchaseAgreementPricedItem & { scope?: string }
  })
  const pricing = composePurchaseAgreementPricing({ basePriceCents: Number(availability.base_price_cents), lotPremiumCents: Number(lot.premium_cents ?? 0), structuralOptions: priced.filter((item: any) => item.scope === "structural"), designSelections: priced.filter((item: any) => item.scope !== "structural"), incentives: requestedIncentives.map((row: any) => ({ incentiveId: row.id, name: row.name, incentiveType: row.incentive_type, appliesTo: row.applies_to, amountCents: row.amount_cents, percent: row.percent })) })
  return { ...pricing, lotId: lot.id, communityId: lot.community_id, housePlanId: version.house_plan_id, housePlanVersionId: version.id, elevationId, swing: parsed.swing ?? lot.swing, planLabel: (version as any).plan?.name ?? version.label ?? "Plan", elevationLabel: (lot as any).elevation?.name ?? (lot as any).elevation?.code ?? null, optionItems: parsed.optionItems }
}

/** What a priced-but-unwritten configuration looks like. */
export type AgreementDraftPricing = Awaited<ReturnType<typeof priceAgreementDraft>>

export type AgreementCatalogItem = {
  optionId?: string
  packageId?: string
  label: string
  category: string | null
  priceCents: number
}

export type AgreementDraftContext = {
  reservationId: string
  lotId: string
  lotLabel: string | null
  communityId: string
  buyerName: string | null
  /**
   * Null blocks the whole flow: `generatePurchaseAgreementSigningDocument` needs
   * somewhere to send the envelope, and it runs *after* the contract row is
   * inserted — so the form must refuse before that, not recover after.
   */
  buyerEmail: string | null
  planLabel: string | null
  elevationLabel: string | null
  swing: "left" | "right" | "either" | null
  /** Set when the lot pins a version (a spec home) and it cannot be changed. */
  pinnedVersionId: string | null
  versions: { id: string; label: string; isPinned: boolean }[]
  elevations: { id: string; label: string }[]
  structuralOptions: AgreementCatalogItem[]
  designSelections: AgreementCatalogItem[]
  packages: AgreementCatalogItem[]
  incentives: { id: string; name: string; summary: string }[]
}

function incentiveSummary(row: {
  incentive_type: string
  amount_cents: number | null
  percent: number | null
  applies_to: string
}): string {
  const value =
    row.incentive_type === "percent_of_base"
      ? `${Number(row.percent ?? 0)}% of base`
      : formatCentsShort(Number(row.amount_cents ?? 0))
  return `${value} · ${row.applies_to === "design_credit" ? "design credit" : "off price"}`
}

function formatCentsShort(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`
}

/**
 * Everything the purchase-agreement form needs, in one round trip: what the lot
 * is already configured as, which released versions and elevations it may be,
 * the community's option catalog split by scope, and the live incentives.
 *
 * Loaded on open rather than with the deal page — a consultant writes a handful
 * of agreements a week and opens the deal file all day, so two thousand catalog
 * options do not ride along with every page view.
 */
export async function getAgreementDraftContext(
  reservationId: string,
  orgId?: string,
): Promise<AgreementDraftContext> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)

  const { data: reservation } = await context.supabase
    .from("lot_reservations")
    .select(
      "id, status, lot_id, community_id, buyer_contact_id, buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name, email), lot:lots(id, community_id, project_id, house_plan_id, house_plan_version_id, house_plan_elevation_id, swing, block, lot_number, plan:house_plans(name), elevation:house_plan_elevations(name, code))",
    )
    .eq("org_id", context.orgId)
    .eq("id", reservationId)
    .maybeSingle()
  if (!reservation) throw new Error("Reservation not found")
  if (reservation.status !== "reserved") {
    throw new Error("Take the reservation first — an agreement needs a reserved lot")
  }
  const lot = Array.isArray(reservation.lot) ? reservation.lot[0] : reservation.lot
  if (!lot) throw new Error("Reservation is not attached to a lot")
  if (!lot.house_plan_id) throw new Error("Assign a plan to the lot before writing the agreement")
  await assertCommunityInSalesScope(context, lot.community_id)

  const buyer = Array.isArray(reservation.buyer) ? reservation.buyer[0] : reservation.buyer
  const plan = Array.isArray(lot.plan) ? lot.plan[0] : lot.plan
  const elevation = Array.isArray(lot.elevation) ? lot.elevation[0] : lot.elevation

  const [{ data: versions }, { data: elevations }, catalog, incentiveRows] = await Promise.all([
    context.supabase
      .from("house_plan_versions")
      .select("id, label, released_at")
      .eq("org_id", context.orgId)
      .eq("house_plan_id", lot.house_plan_id)
      .eq("status", "released")
      .order("released_at", { ascending: false }),
    context.supabase
      .from("house_plan_elevations")
      .select("id, name, code")
      .eq("org_id", context.orgId)
      .eq("house_plan_id", lot.house_plan_id)
      .order("name"),
    listCatalog({ communityId: lot.community_id }),
    listIncentives({ communityId: lot.community_id, status: "active", eligibleOnly: true }, context.orgId),
  ])

  const toItem = (option: { id: string; name: string; price_cents: number | null }, category: string | null) => ({
    optionId: option.id,
    label: option.name,
    category,
    priceCents: Number(option.price_cents ?? 0),
  })
  const sellable = catalog.categories.flatMap((category) =>
    category.options
      .filter((option) => option.is_available && !option.is_archived && !option.is_default)
      .map((option) => ({ option, categoryName: category.name })),
  )

  return {
    reservationId: reservation.id,
    lotId: lot.id,
    lotLabel: lot.block ? `${lot.block}-${lot.lot_number}` : (lot.lot_number ?? null),
    communityId: lot.community_id,
    buyerName: buyer?.full_name ?? null,
    buyerEmail: buyer?.email ?? null,
    planLabel: plan?.name ?? null,
    elevationLabel: elevation?.name ?? elevation?.code ?? null,
    swing: (lot.swing ?? null) as AgreementDraftContext["swing"],
    pinnedVersionId: lot.project_id && lot.house_plan_version_id ? lot.house_plan_version_id : null,
    versions: (versions ?? []).map((version) => ({
      id: version.id as string,
      label: (version.label as string | null) ?? "Released version",
      isPinned: version.id === lot.house_plan_version_id,
    })),
    elevations: (elevations ?? []).map((row) => ({
      id: row.id as string,
      label: (row.name as string | null) ?? (row.code as string | null) ?? "Elevation",
    })),
    structuralOptions: sellable
      .filter(({ option }) => option.option_scope === "structural")
      .map(({ option, categoryName }) => toItem(option, categoryName)),
    designSelections: sellable
      .filter(({ option }) => option.option_scope !== "structural")
      .map(({ option, categoryName }) => toItem(option, categoryName)),
    packages: catalog.packages
      .filter((row) => row.is_available && !row.is_archived)
      .map((row) => ({
        packageId: row.id,
        label: row.name,
        category: "Package",
        priceCents: Number(row.price_cents ?? 0),
      })),
    incentives: (incentiveRows ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      summary: incentiveSummary(
        row as unknown as {
          incentive_type: string
          amount_cents: number | null
          percent: number | null
          applies_to: string
        },
      ),
    })),
  }
}

export async function createPurchaseAgreement(input: unknown, orgId?: string) {
  const parsed = createPurchaseAgreementSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: reservation } = await context.supabase.from("lot_reservations").select("*, lot:lots(project_id, lot_number)").eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
  if (!reservation || reservation.status !== "reserved" || !reservation.lot?.project_id) throw new Error("Reserved lot with a project is required")
  if (reservation.lot_id !== parsed.lotId) throw new Error("Reservation and lot do not match")
  const pricing = await priceAgreementDraft(parsed, context.orgId)
  const now = new Date()
  const number = `PA-${now.getUTCFullYear()}-${now.getTime().toString().slice(-7)}`
  const snapshot = { purchase_agreement: { version: 1, configuration: { lot_id: parsed.lotId, house_plan_id: pricing.housePlanId, house_plan_version_id: pricing.housePlanVersionId, elevation_id: pricing.elevationId, swing: pricing.swing, option_items: pricing.optionItems }, pricing, deposits: reservation.deposit_invoice_id ? [{ invoice_id: reservation.deposit_invoice_id, kind: "earnest_deposit" }] : [], incentive_ids: parsed.incentiveIds } }
  const { data: contract, error } = await context.supabase.from("contracts").insert({ org_id: context.orgId, project_id: reservation.lot.project_id, number, title: `Purchase Agreement — Lot ${reservation.lot.lot_number}`, status: "draft", contract_type: "purchase_agreement", total_cents: pricing.totalCents, currency: "usd", terms: parsed.terms ?? null, effective_date: parsed.effectiveDate ?? now.toISOString().slice(0, 10), snapshot,
    // The buyer belongs on the instrument. Before this, the buyer of record on
    // the largest transaction Arc touches was reachable only by joining out
    // through projects.client_id — the project's CURRENT client, which is not
    // necessarily who signed this agreement.
    buyer_contact_id: reservation.buyer_contact_id ?? null,
    co_buyer_contact_id: reservation.co_buyer_contact_id ?? null }).select("*").single()
  if (error || !contract) throw new Error(`Failed to create purchase agreement: ${error?.message}`)
  await context.supabase.from("lot_reservations").update({ contract_id: contract.id }).eq("org_id", context.orgId).eq("id", reservation.id)
  await context.supabase.from("lots").update({ house_plan_id: pricing.housePlanId, house_plan_version_id: pricing.housePlanVersionId, house_plan_elevation_id: pricing.elevationId }).eq("org_id", context.orgId).eq("id", parsed.lotId)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "purchase_agreement_created", entityType: "contract", entityId: contract.id, payload: { project_id: contract.project_id, total_cents: contract.total_cents } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "contract", entityId: contract.id, after: contract }),
  ])
  const signing = await generatePurchaseAgreementSigningDocument(contract.id, context.orgId)
  return { ...contract, pricing, signing }
}

export async function generatePurchaseAgreementSigningDocument(contractId: string, orgId?: string) {
  if (getFilesStorageProvider() !== "r2") return { documentId: null, envelopeId: null, reason: "Document signing storage is not configured" }
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("*, project:projects(name, client_id, client:contacts(id, full_name, email))").eq("org_id", context.orgId).eq("id", contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract) throw new Error("Purchase agreement not found")
  const project = Array.isArray(contract.project) ? contract.project[0] : contract.project
  const buyer = Array.isArray(project?.client) ? project.client[0] : project?.client
  const { data: reservation } = await context.supabase.from("lot_reservations").select("co_buyer_contact_id, co_buyer:contacts!lot_reservations_co_buyer_contact_id_fkey(id, full_name, email)").eq("org_id", context.orgId).eq("contract_id", contractId).maybeSingle()
  const coBuyer = Array.isArray(reservation?.co_buyer) ? reservation.co_buyer[0] : reservation?.co_buyer
  const { data: builder } = await context.supabase.from("app_users").select("id, full_name, email").eq("id", context.userId).maybeSingle()
  if (!buyer?.email) throw new Error("Buyer email is required before creating a signing envelope")
  if (!builder?.email) throw new Error("The builder signer needs an email address")
  const pricing = (contract.snapshot as any)?.purchase_agreement?.pricing as PurchaseAgreementPricing
  const lines = [
    { description: "Community base price", quantity: 1, unit: "agreement", unit_cost_cents: pricing.basePriceCents, markup_pct: 0 },
    ...(pricing.lotPremiumCents ? [{ description: "Lot premium", quantity: 1, unit: "agreement", unit_cost_cents: pricing.lotPremiumCents, markup_pct: 0 }] : []),
    ...pricing.structuralOptions.map((item) => ({ description: item.label, quantity: 1, unit: "option", unit_cost_cents: item.priceCents, markup_pct: 0 })),
    ...pricing.designSelections.map((item) => ({ description: item.label, quantity: 1, unit: "selection", unit_cost_cents: item.priceCents, markup_pct: 0 })),
    ...pricing.incentives.map((item) => ({ description: `Incentive — ${item.name}`, quantity: 1, unit: "credit", unit_cost_cents: -item.valueCents, markup_pct: 0 })),
  ]
  const branding = await getOrgBranding(context.orgId, context.supabase)
  const pdf = await renderProposalPdf({ orgName: branding.name, orgLogoUrl: branding.logoUrl, orgAddress: branding.address, proposalTitle: contract.title, proposalNumber: contract.number, recipientName: buyer.full_name, recipientEmail: buyer.email, projectName: project?.name ?? null, summary: "New home purchase agreement", terms: contract.terms ?? null, subtotalCents: pricing.totalCents, taxCents: 0, totalCents: pricing.totalCents, validUntil: null, signers: [{ role: "Buyer", name: buyer.full_name }, ...(coBuyer ? [{ role: "Co-buyer", name: coBuyer.full_name }] : []), { role: branding.name ?? "Builder", name: builder.full_name }], lines })
  const fileName = `purchase-agreement-${contract.number ?? contract.id}.pdf`.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(context.orgId, "projects", contract.project_id, "esign", "source", `${Date.now()}_${fileName}`)
  await uploadFilesObject({ supabase: context.supabase, orgId: context.orgId, path: storagePath, bytes: pdf, contentType: "application/pdf", upsert: false })
  const file = await createFileRecord({ project_id: contract.project_id, file_name: fileName, storage_path: storagePath, mime_type: "application/pdf", size_bytes: pdf.length, visibility: "private", category: "contracts", folder_path: "/contracts", source: "generated" }, context.orgId, { authorizationPermission: "sales.manage" })
  const document = await createDocument({ project_id: contract.project_id, document_type: "contract", title: contract.title, source_file_id: file.id, source_entity_type: "contract", source_entity_id: contract.id, metadata: { contract_id: contract.id, purchase_agreement: true } }, context.orgId, { authorizationPermission: "sales.manage" })
  const envelope = await ensureDraftEnvelopeForDocument({ document_id: document.id, source_entity_type: "contract", source_entity_id: contract.id, subject: contract.title, metadata: { contract_id: contract.id } }, context.orgId, "sales.manage")
  const recipients = [
    { recipient_type: "contact" as const, contact_id: buyer.id, name: buyer.full_name, email: buyer.email, role: "signer" as const, signer_role: "buyer", sequence: 1, required: true },
    ...(coBuyer?.email ? [{ recipient_type: "contact" as const, contact_id: coBuyer.id, name: coBuyer.full_name, email: coBuyer.email, role: "signer" as const, signer_role: "co_buyer", sequence: 1, required: true }] : []),
    { recipient_type: "internal_user" as const, user_id: builder.id, name: builder.full_name, email: builder.email, role: "signer" as const, signer_role: "builder", sequence: 2, required: true },
  ]
  await replaceEnvelopeRecipients({ envelope_id: envelope.id, recipients }, context.orgId, "sales.manage")
  const signingRequests = await createEnvelopeSigningRequests({ envelope_id: envelope.id }, context.orgId, "sales.manage")
  const signingSecret = process.env.DOCUMENT_SIGNING_SECRET
  if (!signingSecret) throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  const firstBatch = (signingRequests.requests ?? []).filter((request: any) => Number(request.sequence ?? 1) === 1 && request.sent_to_email)
  await Promise.all(firstBatch.map(async (request: any) => {
    const token = randomBytes(32).toString("hex")
    const tokenHash = createHmac("sha256", signingSecret).update(token).digest("hex")
    await context.supabase.from("document_signing_requests").update({ token_hash: tokenHash, status: "sent", sent_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", request.id)
    const recipient = recipients.find((row) => row.signer_role === request.signer_role)
    const html = await renderEmailTemplate(SignatureEmail({ documentTitle: contract.title, signingLink: buildUnifiedSigningUrl(token), recipientName: recipient?.name ?? undefined, orgName: branding.name, orgLogoUrl: branding.logoUrl, eventLabel: "Purchase Agreement", headline: "Your purchase agreement is ready", bodyText: "Review and sign your new home purchase agreement.", detailLabel: "Agreement", detailText: "Review the price, selections, incentives, and terms before signing.", buttonText: "Review and Sign" }))
    await sendEmail({ to: [request.sent_to_email], subject: `Signature requested: ${contract.title}`, html, from: getOrgSenderEmail(undefined, branding.name) })
  }))
  const sentAt = new Date().toISOString()
  await Promise.all([
    context.supabase.from("documents").update({ status: "sent", updated_at: sentAt }).eq("org_id", context.orgId).eq("id", document.id),
    context.supabase.from("envelopes").update({ status: "sent", sent_at: sentAt, updated_at: sentAt }).eq("org_id", context.orgId).eq("id", envelope.id),
  ])
  return { documentId: document.id, envelopeId: envelope.id, reason: null }
}

export async function hasExecutedPurchaseAgreement(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase.from("contracts").select("id").eq("org_id", context.orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").eq("status", "active").limit(1).maybeSingle()
  if (error) throw new Error(`Failed to check purchase agreement: ${error.message}`)
  return Boolean(data)
}

export async function executePurchaseAgreementFromEnvelopeExecution(input: { orgId: string; contractId: string; envelopeId: string; executedFileId?: string | null }) {
  const supabase = createServiceSupabaseClient()
  const { data: contract } = await supabase.from("contracts").select("*, project:projects(end_date)").eq("org_id", input.orgId).eq("id", input.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (!contract) throw new Error("Purchase agreement not found")
  if (contract.status === "active") return
  const now = new Date().toISOString()
  await supabase.from("contracts").update({ status: "active", signed_at: now, signature_data: { envelope_id: input.envelopeId, executed_file_id: input.executedFileId ?? null } }).eq("org_id", input.orgId).eq("id", contract.id)
  const { data: projectLot } = await supabase.from("lots").select("id, community_id, status").eq("org_id", input.orgId).eq("project_id", contract.project_id).maybeSingle()
  let convertedProspectId: string | null = null
  if (projectLot) {
    const { data: convertedReservations } = await supabase.from("lot_reservations").update({ status: "converted", converted_at: now, contract_id: contract.id }).eq("org_id", input.orgId).eq("lot_id", projectLot.id).eq("status", "reserved").select("prospect_id")
    convertedProspectId = (convertedReservations ?? []).find((row) => row.prospect_id)?.prospect_id ?? null
  }
  // Close the lead-pipeline loop: an executed agreement IS the win.
  if (convertedProspectId) {
    await supabase.from("prospects").update({ status: "won", won_at: now, lost_at: null, lost_reason: null, updated_at: now }).eq("org_id", input.orgId).eq("id", convertedProspectId).neq("status", "won")
  }
  // Stand the buyer's selection groups up at execution, not at release. The
  // start gate asks "are structural selections locked?", and a gate whose
  // evidence is only created during the release it guards can never block one.
  await instantiateSelectionGroupsForProject(contract.project_id, input.orgId)
  await supabase.from("project_selections").update({ locked_at: now }).eq("org_id", input.orgId).eq("project_id", contract.project_id).is("locked_at", null)
  if (projectLot) {
    const { data: existingClosing } = await supabase.from("closings").select("id").eq("org_id", input.orgId).eq("project_id", contract.project_id).neq("status", "cancelled").maybeSingle()
    if (!existingClosing) await supabase.from("closings").insert({ org_id: input.orgId, project_id: contract.project_id, lot_id: projectLot.id, community_id: projectLot.community_id, status: "projected", scheduled_date: contract.project?.end_date ?? null, buyer_contact_id: contract.buyer_contact_id ?? null })
  }
  await Promise.all([
    recordEvent({ orgId: input.orgId, eventType: "purchase_agreement_executed", entityType: "contract", entityId: contract.id, payload: { project_id: contract.project_id, envelope_id: input.envelopeId } }),
    recordAudit({ orgId: input.orgId, action: "update", entityType: "contract", entityId: contract.id, after: { status: "active", signed_at: now } }),
  ])
}

export async function voidPurchaseAgreement(input: unknown, orgId?: string) {
  const parsed = voidPurchaseAgreementSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: contract } = await context.supabase.from("contracts").select("id, project_id, status, snapshot").eq("org_id", context.orgId).eq("id", parsed.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (!contract || !["draft", "active"].includes(contract.status)) throw new Error("Active purchase agreement not found")
  const { data: reservation } = await context.supabase.from("lot_reservations").select("id, prospect_id").eq("org_id", context.orgId).eq("contract_id", contract.id).maybeSingle()
  if (reservation) await releaseReservation({ reservationId: reservation.id, reason: parsed.reason, depositDisposition: parsed.depositDisposition }, context.orgId)
  // A voided agreement un-wins the lead: back to qualified so the funnel stays truthful.
  if (reservation?.prospect_id) {
    await context.supabase.from("prospects").update({ status: "qualified", won_at: null, updated_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("id", reservation.prospect_id).eq("status", "won")
  }
  await Promise.all([
    context.supabase.from("contracts").update({ status: "void", snapshot: { ...(contract.snapshot ?? {}), cancellation_reason: parsed.reason, cancelled_at: new Date().toISOString() } }).eq("org_id", context.orgId).eq("id", contract.id),
    context.supabase.from("closings").update({ status: "cancelled", cancel_reason: parsed.reason }).eq("org_id", context.orgId).eq("project_id", contract.project_id).neq("status", "closed"),
    context.supabase.from("project_selections").update({ locked_at: null }).eq("org_id", context.orgId).eq("project_id", contract.project_id),
    context.supabase.from("portal_access_tokens").update({ revoked_at: new Date().toISOString() }).eq("org_id", context.orgId).eq("project_id", contract.project_id).eq("portal_type", "client").is("revoked_at", null),
    context.supabase.from("projects").update({ client_id: null }).eq("org_id", context.orgId).eq("id", contract.project_id),
  ])
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "purchase_agreement_voided", entityType: "contract", entityId: contract.id, payload: { reason: parsed.reason } })
}
import { createHmac, randomBytes } from "crypto"
