import { readPageOrEmpty } from "@/lib/land/paging"
import { orFilterTerm } from "@/lib/search-picker"
import { assertReservationConversionScope, callReservationConversion, prepareReservationConversionBundle } from "@/lib/services/reservation-conversion"
import { reservationConversionRegistrationSchema, reservationConversionIdentitySchema, reservationConversionScopeSchema, savedReservationConversionInputSchema, type ReservationConversionExpected } from "@/lib/validation/reservation-conversion"
import { readAgreementCatalogRevision } from "@/lib/services/agreement-catalog-revision"
import { logger } from "@/lib/logging/logger"
import { saveAgreementCreation, agreementCreationExpected, type AgreementCreationReceipt } from "@/lib/services/agreement-creation"
import { agreementQuoteFingerprint, AgreementQuoteChangedError } from "@/lib/sales/agreement-quote"
import { agreementStructuralSelections, assertOneStructuralOptionPerCategory } from "@/lib/sales/agreement-selections"
import { readAllRows, readAllRowsById } from "@/lib/land/paging"
import { assertSalesConfiguration } from "@/lib/services/configuration-rules"
import { composePurchaseAgreementPricing, describeIncentiveIneligibility, evaluateIncentiveEligibility, homePriceAdjustments, type HomePriceAdjustment, type PurchaseAgreementIncentive, type PurchaseAgreementPricedItem, type PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { createInvoice } from "@/lib/services/invoices"
import { listCatalog, resolveOptionPricing } from "@/lib/services/option-catalog"
import { instantiateSelectionGroupsForProject } from "@/lib/services/selection-cutoffs"
import { captureHomeMarginBaseline } from "@/lib/services/home-margin-baselines"
import { captureHomeProductRevisions } from "@/lib/services/home-product-revisions"
import { applyCustomerDepositWithContext } from "@/lib/services/books/customer-deposits"
import { projectJournal } from "@/lib/services/books/projector"
import { LIVE_RESERVATION_STATUSES, liveReservationOrFilter } from "@/lib/sales/live-reservation"
import { specCompletionDate, specDispositionExecutionBlock, specHomeIncentiveInForce, specInventoryAge } from "@/lib/sales/spec-inventory"
import { SPEC_PRICE_SELF_SERVE_PERMISSION, parseSpecPriceApprovalBands, requiredSpecPricePermission, specPriceDecisionBlockReason } from "@/lib/sales/spec-price-approval-thresholds"
import { specPriceChangeSchema, specPriceDecisionSchema, specPriceWithdrawalSchema } from "@/lib/validation/spec-inventory"
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
import { revokePortalToken } from "@/lib/services/portal-access"
import { getPlanLadder } from "@/lib/services/house-plans"
import { assertLotFit } from "@/lib/services/lot-fit"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { findContactIdByEmail } from "@/lib/services/party-promotion"
import { chunk } from "@/lib/utils"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createFileRecord } from "@/lib/services/files"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { renderPurchaseAgreementPacket } from "@/lib/pdfs/purchase-agreement-packet"
import { loadAgreementPacketDocuments } from "@/lib/services/agreement-templates"
import { AgreementPacketError, agreementPacketRefusal, agreementPacketSchema, buildScheduleA, describeAgreementPacketRefusal, resolvedAgreementPacketSchema, storedAgreementPacket, type AgreementPacket, type ResolvedAgreementPacket } from "@/lib/sales/agreement-packet"
import { buildOrgScopedPath, getFilesStorageProvider, uploadFilesObject } from "@/lib/storage/files-storage"
import { publishOwnedAgreementDocument, reserveAgreementSigningDocument } from "@/lib/services/agreement-signing-ownership"
import { commissionSigningRefusal } from "@/lib/services/sales-commissions"
import { ensureWarrantyDefaults } from "@/lib/services/warranty-operations"
import { importedAgreementEvidenceMissing } from "@/lib/services/cutover/agreements"
import {
  agreementConfigurationSchema,
  agreementContingencySchema,
  communityBulkRepriceSchema,
  communityPlanPriceSchema,
  createLotHoldSchema,
  createPurchaseAgreementSchema,
  agreementCancellationSchema,
  refreshAgreementPacketSchema,
  convertReservationSchema,
  reservationConversionSourceSchema,
  incentiveSchema,
  releaseReservationSchema,
  voidPurchaseAgreementSchema,
  type AgreementConfigurationInput,
  type IncentiveInput,
} from "@/lib/validation/community-sales"

/** Lot states a buyer can be sold into — controlled land and closed lots are not. */
const SELLABLE_LOT_STATUSES = ["owned", "developed", "assigned", "started"]

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

async function getSalesDivisionAccess(context: OrgContext) {
  return getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
}

export async function assertCommunityInSalesScope(context: OrgContext, communityId: string) {
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

export async function getSalesCommunityIds(context: OrgContext) {
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

/**
 * What a lot asks today, from `sellable_lot_inventory`: the one place the price is derived, so a
 * price band, a price sort and the figure on screen agree and nobody's price depends on which
 * selections they may read. Null when the lot has no plan or the sheet does not price it.
 */
export async function deriveLotAskingPrice(supabase: SupabaseClient, orgId: string, lotId: string): Promise<number | null> {
  const { data, error } = await supabase.from("sellable_lot_inventory").select("asking_price_cents").eq("org_id", orgId).eq("lot_id", lotId).maybeSingle()
  if (error) throw new Error(`Failed to price the lot: ${error.message}`)
  return data?.asking_price_cents == null ? null : Number(data.asking_price_cents)
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
    askingPriceCents: row.asking_price_cents == null ? null : Number(row.asking_price_cents),
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
export async function listSpecInventory(opts: SpecInventoryOptions = {}) {
  return (await listSpecInventoryPage(opts)).lots
}

export type InventoryOrder = "newest" | "lot" | "price_asc" | "price_desc" | "aging"

interface SpecInventoryOptions {
  communityId?: string
  divisionId?: string
  status?: string
  limit?: number
  includeToBeBuilt?: boolean
  /** Lot number, block, plan code or name, or community name. */
  search?: string
  /** `spec` is a started house; `tbb` an unstarted lot the buyer still picks a plan on. */
  availability?: "all" | "spec" | "tbb"
  minBeds?: number
  /** Asking-price band: at least `minPriceCents`, below `maxPriceCents`. An unpriced lot is in no band. */
  minPriceCents?: number
  maxPriceCents?: number
  /** Where the previous page stopped (`nextOffset`). */
  offset?: number
  /**
   * `lot` keeps a community's lots together for a picker; `newest` is the
   * standing-spec view; `aging` puts the longest-standing finished homes first.
   */
  order?: InventoryOrder
}

/** A page whose rows are mostly held or sold keeps reading until it fills, but not forever. */
const INVENTORY_FILL_BATCHES = 5

const NO_INVENTORY = { lots: [], truncated: false, total: 0, nextOffset: null as number | null }

const LOT_INVENTORY_SELECT = "id, community_id, division_id, lot_number, block, status, premium_cents, project_id, project:projects(id, name, start_date, status, completed_on), plan:house_plans(name, beds, baths, heated_sqft, total_sqft), community:communities(name)"

/**
 * Same read, plus how much it left out: `truncated` says more lots matched than
 * were returned, `total` is how many lots the scope and filters match before
 * holds and sales are taken off (so it can only over-count), and `nextOffset`
 * is where the next page starts.
 *
 * Filtering, price and age ordering and paging run in the database against
 * `sellable_lot_inventory`, which derives the asking price and the days a
 * finished home has stood; the lots on the page are then read and priced for display.
 */
export async function listSpecInventoryPage(opts: SpecInventoryOptions = {}) {
  const context = await requireOrgContext()
  await requirePermission("sales.read", context)
  const divisionAccess = await getSalesDivisionAccess(context)
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) return NO_INVENTORY
  if (opts.communityId) await assertCommunityInSalesScope(context, opts.communityId)
  if (!opts.divisionId && divisionAccess.assignedOnly && divisionAccess.divisionIds.length === 0) return NO_INVENTORY
  const term = opts.search ? orFilterTerm(opts.search) : ""
  const limit = Math.min(opts.limit ?? 100, 250)
  const buildQuery = () => {
    let query = context.supabase
      .from("sellable_lot_inventory")
      .select("lot_id, asking_price_cents", { count: "exact" })
      .eq("org_id", context.orgId)
    query = opts.includeToBeBuilt
      ? query.in("status", SELLABLE_LOT_STATUSES)
      : query.not("project_id", "is", null)
    if (opts.availability === "spec") query = query.not("project_id", "is", null)
    if (opts.availability === "tbb") query = query.is("project_id", null)
    if (opts.minBeds) query = query.gte("plan_beds", opts.minBeds)
    if (opts.minPriceCents != null) query = query.gte("asking_price_cents", opts.minPriceCents)
    if (opts.maxPriceCents != null) query = query.lt("asking_price_cents", opts.maxPriceCents)
    if (term) query = query.or(`lot_label.ilike.%${term}%,lot_number.ilike.%${term}%,block.ilike.%${term}%,plan_code.ilike.%${term}%,plan_name.ilike.%${term}%,community_name.ilike.%${term}%`)
    if (opts.communityId) query = query.eq("community_id", opts.communityId)
    if (opts.divisionId) query = query.eq("division_id", opts.divisionId)
    else if (divisionAccess.assignedOnly) query = query.in("division_id", divisionAccess.divisionIds)
    if (opts.status) query = query.eq("status", opts.status)
    switch (opts.order) {
      case "lot": return query.order("community_id").order("lot_number").order("lot_id")
      case "price_asc": return query.order("asking_price_cents", { ascending: true, nullsFirst: false }).order("lot_number").order("lot_id")
      case "price_desc": return query.order("asking_price_cents", { ascending: false, nullsFirst: false }).order("lot_number").order("lot_id")
      case "aging": return query.order("aging_days", { ascending: false }).order("lot_number").order("lot_id")
      default: return query.order("created_at", { ascending: false }).order("lot_id")
    }
  }

  const mapped: SpecInventoryLot[] = []
  let offset = opts.offset ?? 0
  let total = 0
  let more = false
  // A page may never come back empty while lots remain: keep reading past held and sold runs until something is found or the scope is exhausted.
  for (let batch = 0; mapped.length < limit && (batch < INVENTORY_FILL_BATCHES || mapped.length === 0); batch += 1) {
    const { data: page, error, count } = await readPageOrEmpty((start, end) => buildQuery().range(start, end), offset, offset + limit - 1)
    if (error) throw new Error(`Failed to load spec inventory: ${error.message}`)
    total = count ?? 0
    const ids: string[] = page.map((row) => row.lot_id)
    const askingPrices = new Map(page.map((row) => [row.lot_id as string, row.asking_price_cents == null ? null : Number(row.asking_price_cents)]))
    const { data: lots, error: lotsError } = ids.length
      ? await readByIds(ids, (slice) => context.supabase.from("lots").select(LOT_INVENTORY_SELECT).eq("org_id", context.orgId).in("id", slice))
      : { data: [], error: null }
    if (lotsError) throw new Error(`Failed to load spec inventory: ${lotsError.message}`)
    const byId = new Map((lots ?? []).map((lot) => [lot.id, lot]))
    const rows = ids.flatMap((lotId) => byId.get(lotId) ?? [])
    const available = await availableInventory(context, rows, askingPrices)
    const taken = available.slice(0, limit - mapped.length)
    // Stop right after the last lot handed out, so the next page starts at the first one left over.
    const consumed = taken.length === available.length ? ids.length : ids.indexOf(available[taken.length].row.id)
    mapped.push(...taken.map((entry) => entry.lot))
    offset += consumed
    more = offset < total
    if (!more || ids.length < limit) break
  }
  return { lots: mapped, truncated: more, total, nextOffset: more ? offset : null }
}

// A page of lots names up to 500 ids; one `.in()` filter that long overflows the
// request URL, so id lookups read in slices and come back as one result.
const ID_SLICE = 100
async function readByIds<Row>(
  ids: string[],
  read: (slice: string[]) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<{ data: Row[]; error: { message: string } | null }> {
  const results = await Promise.all(chunk(ids, ID_SLICE).map((slice) => read(slice)))
  const failed = results.find((result) => result.error)
  return { data: results.flatMap((result) => result.data ?? []), error: failed?.error ?? null }
}

type SpecInventoryLot = Awaited<ReturnType<typeof mapInventoryRows>>[number]

/** An embedded relation, as PostgREST's typing describes it (one row, or a list of them). */
type Embedded<T> = T | T[] | null

function embeddedOne<T>(value: Embedded<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

/** A lot as `LOT_INVENTORY_SELECT` reads it. */
type LotInventoryRow = {
  id: string
  community_id: string
  division_id: string | null
  lot_number: string
  block: string | null
  status: string
  premium_cents: number | null
  project_id: string | null
  project: Embedded<{ id: string; name: string; start_date: string | null; status: string | null; completed_on: string | null }>
  plan: Embedded<{ name: string | null; beds: number | null; baths: number | null; heated_sqft: number | null; total_sqft: number | null }>
  community: Embedded<{ name: string | null }>
}

/** Takes held and sold lots off a batch and prices what is left. */
async function availableInventory(context: OrgContext, lots: LotInventoryRow[], askingPrices: Map<string, number | null>): Promise<Array<{ row: LotInventoryRow; lot: SpecInventoryLot }>> {
  const lotIds = lots.map((lot) => lot.id)
  const projectIds = lots.flatMap((lot) => (lot.project_id ? [lot.project_id] : []))
  const [{ data: reservations }, { data: agreements }] = await Promise.all([
    readByIds(lotIds, (slice) => context.supabase.from("lot_reservations").select("lot_id").eq("org_id", context.orgId).in("lot_id", slice).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter())),
    readByIds(projectIds, (slice) => context.supabase.from("contracts").select("project_id").eq("org_id", context.orgId).in("project_id", slice).eq("contract_type", "purchase_agreement").eq("status", "active")),
  ])
  const reserved = new Set<string>((reservations ?? []).map((row: { lot_id: string }) => row.lot_id))
  const sold = new Set<string>((agreements ?? []).map((row: { project_id: string }) => row.project_id))
  const availableLots = lots.filter((lot) => !reserved.has(lot.id) && !(lot.project_id && sold.has(lot.project_id)))
  const priced = await mapInventoryRows(context, availableLots, askingPrices)
  return availableLots.map((row, index) => ({ row, lot: priced[index] }))
}

async function mapInventoryRows(context: OrgContext, availableLots: LotInventoryRow[], askingPrices: Map<string, number | null>) {
  const availableProjectIds = availableLots.flatMap((lot) => (lot.project_id ? [lot.project_id] : []))
  const [{ data: completions }, terms] = await Promise.all([
    readByIds(availableProjectIds, (slice) =>
      context.supabase.from("project_financial_settings").select("project_id, books_inventory_completed_on").eq("org_id", context.orgId).in("project_id", slice).not("books_inventory_completed_on", "is", null)),
    readSpecHomeTerms(context, availableLots.flatMap((lot) => (lot.project_id ? [{ lotId: lot.id, projectId: lot.project_id }] : []))),
  ])
  const completedOnByProject = new Map<string, string>((completions ?? []).map((row: { project_id: string; books_inventory_completed_on: string }) => [row.project_id, row.books_inventory_completed_on]))
  return availableLots.map((lot) => {
    const home = terms.get(lot.id)
    const project = embeddedOne(lot.project)
    const plan = embeddedOne(lot.plan)
    return {
      lotId: lot.id,
      lotLabel: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number,
      communityId: lot.community_id,
      communityName: embeddedOne(lot.community)?.name ?? null,
      projectId: lot.project_id,
      projectName: project?.name ?? null,
      planLabel: plan?.name ?? "Unassigned plan",
      beds: plan?.beds != null ? Number(plan.beds) : null,
      baths: plan?.baths != null ? Number(plan.baths) : null,
      sqft: plan?.heated_sqft ?? plan?.total_sqft ?? null,
      isSpec: Boolean(lot.project_id),
      status: lot.status,
      startedAt: project?.start_date ?? null,
      ...specInventoryAge(project, specCompletionDate(lot.project_id ? completedOnByProject.get(lot.project_id) : null, project?.completed_on)),
      /** Whether Books owns the completion date (then sales cannot record one). */
      completionFromBooks: lot.project_id ? completedOnByProject.has(lot.project_id) : false,
      askingPriceCents: askingPrices.get(lot.id) ?? null,
      premiumCents: Number(lot.premium_cents ?? 0),
      incentiveCents: home?.incentiveCents ?? 0,
      incentiveExpiresOn: home?.incentiveExpiresOn ?? null,
      pendingChange: home?.pendingChange ?? null,
      disposition: home?.disposition ?? null,
    }
  })
}

export type SpecPendingChange = {
  id: string
  kind: "price" | "incentive"
  fromCents: number
  toCents: number
  askingPriceCents: number
  requiredPermission: string
  proposedBy: string
}

export type SpecDispositionState = {
  id: string
  kind: "bulk_sale" | "investor_sale"
  status: "proposed" | "approved"
  /** The buyer the disposition names: the only buyer the home may be held for or written to while it is approved. */
  counterpartyContactId: string
  priceCents: number
  carryingCents: number
  impairmentId: string | null
  /** Why an approved disposition cannot be carried out yet; null when it can. */
  blockedReason: string | null
}

type SpecHomeTerms = {
  incentiveCents: number
  incentiveExpiresOn: string | null
  incentiveId: string | null
  pendingChange: SpecPendingChange | null
  disposition: SpecDispositionState | null
}

const SPEC_MOVE_SELECT = "id, lot_id, project_id, community_id, kind, status, asking_price_cents, from_cents, to_cents, incentive_expires_on, required_permission, proposed_by, proposed_at, decided_at"

type SpecMoveRow = {
  id: string
  lot_id: string
  project_id: string
  community_id: string
  kind: "price" | "incentive"
  status: string
  asking_price_cents: number
  from_cents: number
  to_cents: number
  incentive_expires_on: string | null
  required_permission: string
  proposed_by: string
  proposed_at: string
  decided_at: string | null
}

/**
 * Each spec home's own pricing terms: the incentive in force (the last applied or
 * approved incentive move, until it expires or a sale is written after it), a
 * move waiting for approval, and a disposition in flight with what still blocks
 * it. Moves are serialized per home (nothing new while one waits), so the newest
 * incentive row is the one in force.
 */
async function readSpecHomeTerms(context: OrgContext, homes: Array<{ lotId: string; projectId: string }>): Promise<Map<string, SpecHomeTerms>> {
  const terms = new Map<string, SpecHomeTerms>()
  if (homes.length === 0) return terms
  const lotIds = homes.map((home) => home.lotId)
  const projectIds = homes.map((home) => home.projectId)
  const [open, incentives, agreements, dispositions] = await Promise.all([
    readByIds<SpecMoveRow>(lotIds, (slice) => context.supabase.from("spec_price_proposals").select(SPEC_MOVE_SELECT).eq("org_id", context.orgId).in("lot_id", slice).eq("status", "proposed")),
    readByIds<SpecMoveRow>(lotIds, (slice) => context.supabase.from("spec_price_proposals").select(SPEC_MOVE_SELECT).eq("org_id", context.orgId).in("lot_id", slice)
      .eq("kind", "incentive").in("status", ["applied", "approved"]).order("proposed_at", { ascending: false }).limit(slice.length * 10)),
    readByIds(projectIds, (slice) => context.supabase.from("contracts").select("project_id, created_at").eq("org_id", context.orgId).in("project_id", slice).eq("contract_type", "purchase_agreement")),
    readByIds(projectIds, (slice) => context.supabase.from("spec_dispositions").select("id, project_id, kind, status, counterparty_contact_id, price_cents, carrying_cents, impairment_id").eq("org_id", context.orgId).in("project_id", slice).in("status", ["proposed", "approved"])),
  ])
  for (const result of [open, incentives, agreements, dispositions]) {
    if (result.error) throw new Error(`Failed to read spec pricing terms: ${result.error.message}`)
  }
  const impairmentIds = dispositions.data.flatMap((row) => (row.status === "approved" && row.impairment_id ? [String(row.impairment_id)] : []))
  const impairmentStatus = await readImpairmentStatuses(context.orgId, impairmentIds)
  const latestAgreementAt = new Map<string, string>()
  for (const row of agreements.data) {
    const previous = latestAgreementAt.get(row.project_id)
    if (!previous || Date.parse(row.created_at) > Date.parse(previous)) latestAgreementAt.set(row.project_id, row.created_at)
  }
  const today = new Date().toISOString().slice(0, 10)
  for (const home of homes) {
    const waiting = open.data.find((row) => row.lot_id === home.lotId)
    const incentive = incentives.data.find((row) => row.lot_id === home.lotId)
    const incentiveCents = specHomeIncentiveInForce(
      incentive ? { cents: Number(incentive.to_cents), expiresOn: incentive.incentive_expires_on, decidedAt: incentive.decided_at ?? incentive.proposed_at } : null,
      { latestAgreementAt: latestAgreementAt.get(home.projectId) ?? null, today },
    )
    const disposition = dispositions.data.find((row) => row.project_id === home.projectId)
    terms.set(home.lotId, {
      incentiveCents,
      incentiveExpiresOn: incentiveCents > 0 ? incentive?.incentive_expires_on ?? null : null,
      incentiveId: incentiveCents > 0 ? incentive?.id ?? null : null,
      pendingChange: waiting
        ? { id: waiting.id, kind: waiting.kind, fromCents: Number(waiting.from_cents), toCents: Number(waiting.to_cents), askingPriceCents: Number(waiting.asking_price_cents), requiredPermission: waiting.required_permission, proposedBy: waiting.proposed_by }
        : null,
      disposition: disposition
        ? {
            id: disposition.id,
            kind: disposition.kind,
            status: disposition.status,
            counterpartyContactId: disposition.counterparty_contact_id,
            priceCents: Number(disposition.price_cents),
            carryingCents: Number(disposition.carrying_cents),
            impairmentId: disposition.impairment_id ?? null,
            blockedReason: disposition.status === "approved"
              ? specDispositionExecutionBlock({
                  status: disposition.status,
                  priceCents: Number(disposition.price_cents),
                  carryingCents: Number(disposition.carrying_cents),
                  impairmentStatus: disposition.impairment_id ? impairmentStatus.get(String(disposition.impairment_id)) ?? null : null,
                })
              : null,
          }
        : null,
    })
  }
  return terms
}

/**
 * Write-down review statuses, read with the service client: whether a sale may
 * proceed depends on the Books review itself, which sales staff cannot read, so
 * only the status of reviews this org's own dispositions name is returned.
 */
export async function readImpairmentStatuses(orgId: string, impairmentIds: string[]) {
  const statuses = new Map<string, "proposed" | "approved" | "rejected">()
  if (impairmentIds.length === 0) return statuses
  const { data, error } = await createServiceSupabaseClient().from("books_inventory_impairments").select("id, status").eq("org_id", orgId).in("id", impairmentIds)
  if (error) throw new Error(`Failed to read the write-down reviews: ${error.message}`)
  for (const row of data ?? []) {
    if (row.status === "proposed" || row.status === "approved" || row.status === "rejected") statuses.set(String(row.id), row.status)
  }
  return statuses
}

/** The organization's spec price bands (`org_settings.settings.spec_price_approval_bands`). */
async function readSpecPriceApprovalBands(context: OrgContext) {
  const { data, error } = await context.supabase.from("org_settings").select("settings").eq("org_id", context.orgId).maybeSingle()
  if (error) throw new Error(`Failed to read the price approval policy: ${error.message}`)
  const settings: unknown = data?.settings
  return parseSpecPriceApprovalBands(settings && typeof settings === "object" ? Reflect.get(settings, "spec_price_approval_bands") : undefined)
}

/** The organization's spec price bands, so a screen can say before saving whether a move needs approval. */
export async function getSpecPriceApprovalBands(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  return readSpecPriceApprovalBands(context)
}

/** A started home with no live reservation and no open agreement, read for a price move. */
export async function readStandingSpec(context: OrgContext, lotId: string) {
  const { data: lot, error } = await context.supabase.from("lots").select("id, community_id, project_id, updated_at").eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  await assertCommunityInSalesScope(context, lot.community_id)
  if (!lot.project_id) throw new Error("Only a home that has been started can carry its own price or incentive.")
  const [reservations, agreements, askingPriceCents, terms] = await Promise.all([
    context.supabase.from("lot_reservations").select("id").eq("org_id", context.orgId).eq("lot_id", lot.id).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()).limit(1),
    context.supabase.from("contracts").select("id").eq("org_id", context.orgId).eq("project_id", lot.project_id).eq("contract_type", "purchase_agreement").in("status", ["draft", "active"]).limit(1),
    deriveLotAskingPrice(context.supabase, context.orgId, lot.id),
    readSpecHomeTerms(context, [{ lotId: lot.id, projectId: lot.project_id }]),
  ])
  if (reservations.error || agreements.error) throw new Error("The home's sale status could not be verified. No price was changed.")
  if ((reservations.data ?? []).length || (agreements.data ?? []).length) throw new Error("This home is reserved or under agreement; its price is set by the agreement.")
  const home = terms.get(lot.id)
  return {
    lot: { id: String(lot.id), communityId: String(lot.community_id), projectId: String(lot.project_id), updatedAt: String(lot.updated_at) },
    askingPriceCents,
    incentiveCents: home?.incentiveCents ?? 0,
    pendingChange: home?.pendingChange ?? null,
    disposition: home?.disposition ?? null,
  }
}

const STALE_PRICE = "The asking price changed since you opened it. Review the current price and try again."
const STALE_INCENTIVE = "The home's incentive changed since you opened it. Review it and try again."

/**
 * Move one standing spec's asking price or its own incentive. A move inside the
 * organization's band applies at once, as it always has; a larger one is
 * recorded as a proposal and waits for a second person holding the band's
 * permission (`decideSpecPriceChange`). Either way the move is a row in
 * `spec_price_proposals`, so the home's price history is queryable, not only
 * in the audit log.
 *
 * Nothing here touches an agreement, a budget or a margin baseline — margin
 * history is read from those, never from the asking price. A home with a live
 * reservation or an open agreement is sold stock; its price is the agreement's.
 * One move at a time: while a move waits, the home takes no other.
 */
export async function proposeSpecPriceChange(input: unknown, orgId?: string) {
  const parsed = specPriceChangeSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const [home, bands] = await Promise.all([readStandingSpec(context, parsed.lotId), readSpecPriceApprovalBands(context)])
  if (home.pendingChange) throw new Error("A price change is waiting for approval on this home. Decide or withdraw it first.")
  if (home.disposition) throw new Error("This home is being sold off; its price is the disposition's.")
  if (home.askingPriceCents !== parsed.expectedAskingPriceCents) throw new Error(STALE_PRICE)
  if (parsed.kind === "incentive" && home.incentiveCents !== parsed.expectedIncentiveCents) throw new Error(STALE_INCENTIVE)
  const fromCents = parsed.kind === "price" ? parsed.expectedAskingPriceCents : home.incentiveCents
  if (fromCents === parsed.toCents) throw new Error("Nothing changes: the new figure is the current one.")
  const requiredPermission = requiredSpecPricePermission({ moveCents: parsed.toCents - fromCents, askingPriceCents: home.askingPriceCents, bands })
  const apply = requiredPermission === SPEC_PRICE_SELF_SERVE_PERMISSION
  // Service role: the band computed above is the only source of the apply flag and the permission.
  const { data: moveId, error } = await createServiceSupabaseClient().rpc("record_spec_price_move", {
    p_org_id: context.orgId,
    p_lot_id: home.lot.id,
    p_project_id: home.lot.projectId,
    p_community_id: home.lot.communityId,
    p_kind: parsed.kind,
    p_asking_price_cents: home.askingPriceCents,
    p_from_cents: fromCents,
    p_to_cents: parsed.toCents,
    p_expires_on: parsed.kind === "incentive" ? parsed.expiresOn : null,
    p_reason: parsed.reason,
    p_required_permission: requiredPermission,
    p_apply: apply,
    p_lot_updated_at: home.lot.updatedAt,
    p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const proposalId = z.string().uuid().parse(moveId)
  const status = apply ? "applied" : "proposed"
  const eventType = !apply ? "spec_home.price_change_proposed" : parsed.kind === "price" ? "spec_home.repriced" : "spec_home.incentive_changed"
  const payload = { lot_id: home.lot.id, community_id: home.lot.communityId, project_id: home.lot.projectId, kind: parsed.kind, from_cents: fromCents, to_cents: parsed.toCents, asking_price_cents: home.askingPriceCents, required_permission: requiredPermission, reason: parsed.reason }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType, entityType: "spec_price_proposal", entityId: proposalId, payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "spec_price_proposal", entityId: proposalId, after: { ...payload, status } }),
  ])
  return {
    proposalId,
    status,
    requiredPermission,
    askingPriceCents: apply && parsed.kind === "price" ? parsed.toCents : home.askingPriceCents,
    incentiveCents: apply && parsed.kind === "incentive" ? parsed.toCents : home.incentiveCents,
  }
}

/**
 * Approve or reject a waiting move. The decider needs the permission the move's
 * band named, is never the proposer, and approves only the price they are
 * looking at: the home must still ask (and still carry the incentive) it did
 * when the move was proposed, and must still be unsold. The decision and the
 * price it sets land in one transaction (`decide_spec_price_proposal`), claimed
 * on the proposal's status, so two deciders cannot both act.
 */
export async function decideSpecPriceChange(input: unknown, orgId?: string) {
  const parsed = specPriceDecisionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: proposal, error } = await context.supabase.from("spec_price_proposals").select(SPEC_MOVE_SELECT).eq("org_id", context.orgId).eq("id", parsed.proposalId).maybeSingle()
  if (error || !proposal) throw new Error("Price change not found")
  const move: SpecMoveRow = proposal
  await requirePermission(move.required_permission, context)
  const blocked = specPriceDecisionBlockReason({ status: move.status, proposedBy: move.proposed_by, deciderId: context.userId })
  if (blocked) throw new Error(blocked)
  let lotUpdatedAt: string | null = null
  if (parsed.approve) {
    const home = await readStandingSpec(context, move.lot_id)
    if (home.askingPriceCents !== Number(move.asking_price_cents)) throw new Error("The home's asking price changed after this was proposed. Reject it and propose again from the current price.")
    if (move.kind === "incentive" && home.incentiveCents !== Number(move.from_cents)) throw new Error("The home's incentive changed after this was proposed. Reject it and propose again.")
    lotUpdatedAt = home.lot.updatedAt
  } else {
    await assertCommunityInSalesScope(context, move.community_id)
  }
  const { error: decideError } = await createServiceSupabaseClient().rpc("decide_spec_price_proposal", {
    p_org_id: context.orgId,
    p_proposal_id: move.id,
    p_approve: parsed.approve,
    p_note: parsed.note ?? null,
    p_lot_updated_at: lotUpdatedAt,
    p_actor_id: context.userId,
  })
  if (decideError) throw new Error(decideError.message)
  const status = parsed.approve ? "approved" : "rejected"
  const payload = { lot_id: move.lot_id, community_id: move.community_id, project_id: move.project_id, kind: move.kind, from_cents: Number(move.from_cents), to_cents: Number(move.to_cents), proposed_by: move.proposed_by, note: parsed.note ?? null }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `spec_home.price_change_${status}`, entityType: "spec_price_proposal", entityId: move.id, payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_price_proposal", entityId: move.id, before: { status: move.status }, after: { ...payload, status } }),
  ])
  return { proposalId: move.id, status }
}

/** The proposer takes back a move nobody has decided. */
export async function withdrawSpecPriceChange(input: unknown, orgId?: string) {
  const parsed = specPriceWithdrawalSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data, error } = await context.supabase.from("spec_price_proposals")
    .update({ status: "withdrawn", decided_at: new Date().toISOString() })
    .eq("org_id", context.orgId).eq("id", parsed.proposalId).eq("status", "proposed").eq("proposed_by", context.userId)
    .select("id, lot_id").maybeSingle()
  if (error) throw new Error(`Failed to withdraw the price change: ${error.message}`)
  if (!data) throw new Error("Only a waiting price change you proposed can be withdrawn.")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "spec_home.price_change_withdrawn", entityType: "spec_price_proposal", entityId: data.id, payload: { lot_id: data.lot_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "spec_price_proposal", entityId: data.id, before: { status: "proposed" }, after: { status: "withdrawn" } }),
  ])
  return { proposalId: data.id, status: "withdrawn" as const }
}

const SELLABLE_LOT_PICKER_LIMIT = 500

/** Sellable lots for the hold flow (`truncated` when the community has more than the picker shows): owned/developed/assigned/started, no live reservation, not sold. */
export async function listSellableLots(communityId: string, search?: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  let lotQuery = context.supabase
    .from("lots")
    .select("id, lot_number, status, premium_cents, project_id, plan:house_plans(name)", { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .in("status", SELLABLE_LOT_STATUSES)
  const term = search?.trim()
  if (term) lotQuery = lotQuery.ilike("lot_number", `%${term.replace(/[\\%_,()]/g, "")}%`)
  const { data: lots, error, count } = await lotQuery.order("lot_number").order("id").limit(SELLABLE_LOT_PICKER_LIMIT)
  if (error) throw new Error(`Failed to list lots: ${error.message}`)
  const truncated = (count ?? 0) > SELLABLE_LOT_PICKER_LIMIT
  const lotIds = (lots ?? []).map((lot: any) => lot.id)
  const projectIds = (lots ?? []).map((lot: any) => lot.project_id).filter(Boolean)
  const [{ data: reservations }, { data: agreements }] = await Promise.all([
    readByIds(lotIds, (slice) => context.supabase.from("lot_reservations").select("lot_id").eq("org_id", context.orgId).in("lot_id", slice).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter())),
    readByIds(projectIds, (slice) => context.supabase.from("contracts").select("project_id").eq("org_id", context.orgId).in("project_id", slice).eq("contract_type", "purchase_agreement").eq("status", "active")),
  ])
  const reserved = new Set((reservations ?? []).map((row: any) => row.lot_id))
  const sold = new Set((agreements ?? []).map((row: any) => row.project_id))
  const options = (lots ?? [])
    .filter((lot: any) => !reserved.has(lot.id) && !(lot.project_id && sold.has(lot.project_id)))
    .map((lot: any) => ({
      id: lot.id as string,
      lotNumber: lot.lot_number as string,
      status: lot.status as string,
      premiumCents: Number(lot.premium_cents ?? 0),
      isSpec: Boolean(lot.project_id),
      planLabel: ((Array.isArray(lot.plan) ? lot.plan[0]?.name : lot.plan?.name) ?? null) as string | null,
    }))
  return { lots: options, truncated }
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
    askingPriceCents: row.asking_price_cents == null ? null : Number(row.asking_price_cents),
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
  if (!buyerContactId && primary.email) buyerContactId = await findContactIdByEmail(context.supabase, context.orgId, primary.email)
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

function dispositionKindLabel(kind: string) {
  return kind === "bulk_sale" ? "bulk sale" : kind === "investor_sale" ? "investor sale" : "disposition"
}

/**
 * While an approved disposition names a home's buyer, the home is that buyer's:
 * a hold or an agreement for anybody else is refused (the hold insert trigger
 * says the same). Proposed dispositions do not reserve anything.
 */
async function assertDispositionBuyer(context: OrgServiceContext, lotId: string, buyerIds: Array<string | null>) {
  const { data, error } = await context.supabase.from("spec_dispositions").select("kind, counterparty_contact_id")
    .eq("org_id", context.orgId).eq("lot_id", lotId).eq("status", "approved").maybeSingle()
  if (error) throw new Error(`Failed to verify the home's disposition: ${error.message}`)
  if (!data || buyerIds.includes(data.counterparty_contact_id)) return
  throw new Error(`This home is being sold through an approved ${dispositionKindLabel(String(data.kind))} to another buyer. Cancel the disposition before selling it to someone else.`)
}

export async function createLotHold(input: unknown, orgId?: string) {
  const parsed = createLotHoldSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: lot, error } = await context.supabase.from("lots").select("id, community_id, status, premium_cents, asking_price_override_cents, project_id, house_plan_id, house_plan_elevation_id").eq("org_id", context.orgId).eq("id", parsed.lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  if (!["owned", "developed", "assigned", "started"].includes(lot.status)) throw new Error("This lot is not sellable")
  await assertDispositionBuyer(context, lot.id, [parsed.buyerContactId, parsed.coBuyerContactId ?? null])
  const { data, error: insertError } = await context.supabase.from("lot_reservations").insert({
    org_id: context.orgId, community_id: lot.community_id, lot_id: lot.id,
    buyer_contact_id: parsed.buyerContactId, co_buyer_contact_id: parsed.coBuyerContactId ?? null,
    prospect_id: parsed.prospectId ?? null, status: "hold", expires_at: parsed.expiresAt,
    asking_price_cents: await deriveLotAskingPrice(context.supabase, context.orgId, lot.id), notes: parsed.notes ?? null,
    created_by: context.userId,
  }).select("*, lot:lots(lot_number, project_id), buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name)").single()
  // The insert locks the lot and expires its lapsed hold first, so only a live hold or the
  // lot's home belonging to someone else (23514) refuses it.
  if (insertError || !data) throw new Error(insertError?.code === "23505" ? "This lot already has a live reservation" : insertError?.code === "23514" ? insertError.message : `Failed to hold lot: ${insertError?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_hold_created", entityType: "lot_reservation", entityId: data.id, payload: { lot_id: lot.id, community_id: lot.community_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "lot_reservation", entityId: data.id, after: data }),
  ])
  return reservationDto(data)
}

async function readReservationConversionSource(parsed: z.infer<typeof convertReservationSchema>, context: OrgServiceContext) {
  const source = await context.supabase.from("lot_reservations")
    .select("id, org_id, community_id, lot_id, buyer_contact_id, co_buyer_contact_id, prospect_id, status, expires_at, updated_at, deposit_invoice_id, contract_id, lot:lots(id, org_id, community_id, division_id, lot_number, status, project_id, updated_at)")
    .eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
  if (source.error) throw new Error(`Failed to verify the lot hold: ${source.error.message}`)
  const reservation = reservationConversionSourceSchema.parse(source.data)
  if (reservation.id !== parsed.reservationId || reservation.org_id !== context.orgId || reservation.lot.id !== reservation.lot_id || reservation.lot.org_id !== context.orgId || reservation.lot.community_id !== reservation.community_id) throw new Error("The hold or lot ownership changed. Review the buyer file before reserving.")
  if (reservation.expires_at && Date.parse(reservation.expires_at) <= Date.now()) throw new Error("This lot hold has expired. Review available inventory before reserving.")
  if (reservation.deposit_invoice_id || reservation.contract_id) throw new Error("This hold already has a deposit or agreement. Review its saved records before reserving.")
  const [community, buyers, deposits] = await Promise.all([
    context.supabase.from("communities").select("id, name, division_id, updated_at").eq("org_id", context.orgId).eq("id", reservation.community_id).maybeSingle(),
    context.supabase.from("contacts").select("id, full_name, email, updated_at").eq("org_id", context.orgId).in("id", [reservation.buyer_contact_id, ...(reservation.co_buyer_contact_id ? [reservation.co_buyer_contact_id] : [])]),
    context.supabase.from("invoices").select("id").eq("org_id", context.orgId).eq("metadata->>invoice_kind", "earnest_deposit").eq("metadata->>source_reservation_id", reservation.id).limit(1),
  ])
  if (community.error || buyers.error || deposits.error) throw new Error("The community, buyer or previous deposit could not be verified. No conversion was started.")
  if (!community.data || (reservation.lot.division_id && reservation.lot.division_id !== community.data.division_id)) throw new Error("The lot community or division changed. Review the buyer file before reserving.")
  const access = await getSalesDivisionAccess(context)
  if (access.assignedOnly && (!community.data.division_id || !access.divisionIds.includes(community.data.division_id))) throw new Error("This community is outside your sales division access.")
  if (!buyers.data?.some(buyer => buyer.id === reservation.buyer_contact_id) || (reservation.co_buyer_contact_id && (reservation.co_buyer_contact_id === reservation.buyer_contact_id || !buyers.data.some(buyer => buyer.id === reservation.co_buyer_contact_id)))) throw new Error("The reservation buyer or co-buyer is unavailable in this organization.")
  if (!deposits.data || deposits.data.length) throw new Error("A previous deposit may already exist for this hold. Inspect its invoice before retrying the reservation.")
  let home: ReservationConversionExpected["home"] = null
  if (reservation.lot.project_id) {
    await requireAuthorization({ ...context, projectId: reservation.lot.project_id, permission: "sales.manage" })
    const [homeResult, agreements] = await Promise.all([
      context.supabase.from("projects").select("id, name, property_type, division_id, client_id, updated_at").eq("org_id", context.orgId).eq("id", reservation.lot.project_id).maybeSingle(),
      context.supabase.from("contracts").select("id").eq("org_id", context.orgId).eq("project_id", reservation.lot.project_id).eq("contract_type", "purchase_agreement").in("status", ["draft", "active"]).limit(1),
    ])
    if (homeResult.error || agreements.error || !homeResult.data || !agreements.data) throw new Error("The held home or existing agreement could not be verified.")
    if (homeResult.data.property_type !== "production" || (homeResult.data.client_id && homeResult.data.client_id !== reservation.buyer_contact_id) || agreements.data.length) throw new Error("This home already belongs to another sale or cannot be reserved.")
    home = homeResult.data
  }
  return { reservation, community: community.data, buyers: buyers.data, home }
}

export async function convertHoldToReservation(input: unknown, orgId?: string) {
  const identity = reservationConversionIdentitySchema.extend({ input: savedReservationConversionInputSchema }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  if (identity.input.reservationId !== identity.scope.reservationId) throw new Error("Original reservation identity required")
  return callReservationConversion({ context, scope: identity.scope, action: "commit", requestKey: identity.requestKey, input: identity.input })
}

/** Persist a review without creating a home, assigning its lot or issuing money. */
export async function registerReservationConversion(input: unknown, orgId?: string) {
  const parsed = reservationConversionRegistrationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  assertReservationConversionScope(parsed.scope, context)
  // Probe the original key first. A lost registration reply must not regenerate
  // its planned home, invoice token, recipient evidence or source versions.
  const saved = await callReservationConversion({ context, scope: parsed.scope, action: "inspect", requestKey: parsed.requestKey })
  const body = savedReservationConversionInputSchema.parse({ ...parsed.input, projectName: parsed.input.projectName ?? null })
  if (saved) {
    if (saved.input.depositCents !== body.depositCents || saved.input.projectName !== body.projectName) throw new Error("Changed inputs cannot reuse the saved reservation review")
    return saved
  }
  const source = await readReservationConversionSource(parsed.input, context)
  const [organization, accounting] = await Promise.all([
    context.supabase.from("orgs").select("name, billing_email, address").eq("id", context.orgId).maybeSingle(),
    source.home ? Promise.resolve({ data: null, error: null }) : context.supabase.from("accounting_entity_map").select("*").eq("org_id", context.orgId).is("project_id", null).is("community_id", null).is("division_id", null).maybeSingle(),
  ])
  if (organization.error || !organization.data || accounting.error) throw new Error("The original billing defaults could not be verified. No reservation review was saved.")
  const { lot, ...reservation } = source.reservation
  const bundle = prepareReservationConversionBundle({ context, requestKey: parsed.requestKey, input: body, expected: {
    reservation, lot, community: source.community, home: source.home, buyers: source.buyers,
    // The database verifies the sender as it reads it: billing email, no phone.
    organization: { name: organization.data.name, email: organization.data.billing_email, phone: null, address: organization.data.address }, accountingDefault: accounting.data,
  } })
  return callReservationConversion({ context, scope: parsed.scope, action: "register", requestKey: parsed.requestKey, input: body, bundle })
}

export async function inspectReservationConversion(input: unknown, orgId?: string) {
  const parsed = z.object({ scope: reservationConversionScopeSchema, requestKey: z.string().uuid().optional() }).strict().parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  return callReservationConversion({ context, scope: parsed.scope, action: "inspect", requestKey: parsed.requestKey })
}

export async function cancelReservationConversion(input: unknown, orgId?: string) {
  const parsed = reservationConversionIdentitySchema.extend({ input: savedReservationConversionInputSchema }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  return callReservationConversion({ context, scope: parsed.scope, requestKey: parsed.requestKey, input: parsed.input, action: "cancel" })
}

/**
 * Release a hold or reservation. The status transition is the fence and it is
 * claimed first, in one locked database step (`release_lot_reservation`), so of
 * two releases racing on one reservation only one ever moves the deposit. A
 * reservation with an open purchase agreement is released by voiding the
 * agreement, and a released sale hands its home back to inventory.
 */
export async function releaseReservation(input: unknown, orgId?: string) {
  const parsed = releaseReservationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: reservation, error: readError } = await context.supabase.from("lot_reservations").select("id, status, deposit_invoice_id, buyer_contact_id, lot:lots(project_id)").eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
  if (readError) throw new Error(`Failed to load the reservation: ${readError.message}`)
  if (!reservation || !LIVE_RESERVATION_STATUSES.includes(reservation.status)) throw new Error("Live reservation not found")
  const depositInvoiceId: string | null = parsed.depositDisposition ? reservation.deposit_invoice_id : null
  if (depositInvoiceId) await requirePermission("payment.release", context)

  const { data: claim, error: claimError } = await createServiceSupabaseClient().rpc("release_lot_reservation", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_reservation_id: reservation.id, p_reason: parsed.reason, p_deposit_disposition: parsed.depositDisposition ?? null,
  })
  if (claimError) throw new Error(claimError.message)
  const released = z.object({ before: z.record(z.unknown()), after: z.record(z.unknown()) }).parse(claim)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_reservation_released", entityType: "lot_reservation", entityId: reservation.id, payload: { reason: parsed.reason, deposit_disposition: parsed.depositDisposition } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot_reservation", entityId: reservation.id, before: released.before, after: released.after }),
  ])

  if (depositInvoiceId) {
    try {
      const payments = await availableDepositPayments(context, depositInvoiceId)
      const availableCents = payments.reduce((sum, payment) => sum + payment.availableCents, 0)
      if (parsed.depositDisposition === "refund") {
        await refundDeposit(context, { amountCents: availableCents, payments, reason: parsed.reason, metadata: { source_reservation_id: reservation.id } })
      } else {
        const lot = Array.isArray(reservation.lot) ? reservation.lot[0] : reservation.lot
        if (!lot?.project_id) throw new Error("A forfeited deposit needs the reservation's project to post against")
        await forfeitDeposit(context, { source: { source_reservation_id: reservation.id }, projectId: lot.project_id, buyerContactId: reservation.buyer_contact_id ?? null,
          reason: parsed.reason, amountCents: availableCents, payments })
        await projectJournal(context.orgId, { full: false })
      }
    } catch (error) {
      throw new Error(`The reservation was released, but its deposit ${parsed.depositDisposition} did not finish: ${(error as Error).message}. Complete it from the deposit invoice.`)
    }
  }

  const { data, error } = await context.supabase.from("lot_reservations").select("*, lot:lots(lot_number, project_id), buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name)").eq("org_id", context.orgId).eq("id", reservation.id).single()
  if (error || !data) throw new Error(`Failed to read the released reservation: ${error?.message}`)
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
  const [{ data: availability, error }, lotsPaged, { data: community }, { data: libraryPlans }, incentives] = await Promise.all([
    context.supabase.from("community_plan_availability").select("id, base_price_cents, elevation_id, metadata, plan:house_plans(id, name, code, beds, baths, heated_sqft, stories, garage_bays), elevation:house_plan_elevations(name, code)").eq("org_id", context.orgId).eq("community_id", communityId).eq("is_available", true).or(`effective_start.is.null,effective_start.lte.${onDate}`).or(`effective_end.is.null,effective_end.gte.${onDate}`),
    // One read of the lots answers three questions: what premiums the sheet's
    // "from" price spans, which plans are actually moving, and what a lot here
    // costs — the denominator under any margin the sheet reports.
    readAllRows<{ status: string; house_plan_id: string | null; premium_cents: number | null; cost_basis_cents: number | null }>(
      (from, to) => context.supabase.from("lots").select("status, house_plan_id, premium_cents, cost_basis_cents").eq("org_id", context.orgId).eq("community_id", communityId).order("id", { ascending: true }).range(from, to),
      { cap: PRICE_SHEET_LOT_CAP + 1, label: "Failed to load price sheet lots" },
    ),
    context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", communityId).maybeSingle(),
    // How much of the library this community actually sells. An offering that is
    // four of eleven plans is a decision; it used to be invisible.
    context.supabase.from("house_plans").select("id, division_id").eq("org_id", context.orgId).eq("status", "active").limit(500),
    listIncentives({ communityId, status: "active", eligibleOnly: true }, context.orgId),
  ])
  if (error) throw new Error(`Failed to load price sheet: ${error.message}`)

  // Read one past the cap: that extra lot is the proof some were left out.
  const lotRows = lotsPaged.rows.slice(0, PRICE_SHEET_LOT_CAP)
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
    lotsTruncated: lotsPaged.rows.length > PRICE_SHEET_LOT_CAP,
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

  const [ladder, lotsPaged] = await Promise.all([
    getPlanLadder({ communityId }, context.orgId),
    readAllRows<{ cost_basis_cents: number | null }>(
      (from, to) =>
        context.supabase
          .from("lots")
          .select("cost_basis_cents")
          .eq("org_id", context.orgId)
          .eq("community_id", communityId)
          .gt("cost_basis_cents", 0)
          .order("id", { ascending: true })
          .range(from, to),
      { cap: PRICE_SHEET_LOT_CAP, label: "Failed to load lot basis" },
    ),
  ])

  const buildCostByPlanId: Record<string, number> = {}
  for (const rung of ladder.rungs) {
    if (rung.released_cost_cents != null) buildCostByPlanId[rung.id] = rung.released_cost_cents
  }
  return {
    lotBasisCents: median(lotsPaged.rows.map((lot) => Number(lot.cost_basis_cents ?? 0))),
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
  const conflicts: string[] = []
  for (const row of rows ?? []) {
    const current = Number(row.base_price_cents)
    // Targets come from the price the caller saw, never from the current one,
    // so a retry of the same request lands on the same price instead of
    // compounding the percentage.
    const basis = parsed.basisCents[row.id]
    const next = Math.max(
      0,
      Math.round(parsed.mode === "percent" ? basis * (1 + parsed.value / 100) : basis + parsed.value),
    )
    if (current === next) continue
    if (current !== basis) {
      conflicts.push(row.id)
      continue
    }
    const { data: updated, error: updateError } = await context.supabase
      .from("community_plan_availability")
      .update({ base_price_cents: next, metadata: repriceMetadata(row) })
      .eq("org_id", context.orgId)
      .eq("id", row.id)
      .eq("base_price_cents", basis)
      .select("id")
      .maybeSingle()
    if (updateError) throw new Error(`Failed to reprice: ${updateError.message}`)
    if (!updated) {
      conflicts.push(row.id)
      continue
    }
    repriced += 1
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community_plan_availability.repriced", entityType: "house_plan", entityId: row.house_plan_id, payload: { community_id: parsed.communityId, elevation_id: row.elevation_id, base_price_cents: next, bulk: true } })
  }
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community", entityId: parsed.communityId, after: { repriced, conflicts: conflicts.length, mode: parsed.mode, value: parsed.value } })
  return { repriced, conflicts }
}

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

/**
 * One page of the released plans this community could sell but is not offering
 * yet, found by code or name. Only a released plan version can be sold — an
 * unreleased plan has no priced takeoff behind it, so offering it would promise
 * an unbuildable home.
 */
export async function searchOfferablePlans(
  communityId: string,
  input: { search?: string; page?: number; pageSize?: number } = {},
  orgId?: string,
): Promise<{ plans: Array<{ id: string; code: string | null; name: string }>; page: number; pageSize: number; total: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await assertCommunityInSalesScope(context, communityId)
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(Math.max(1, input.pageSize ?? 25), 50)
  const offered = await readAllRows<{ house_plan_id: string }>(
    (from, to) => context.supabase.from("community_plan_availability").select("house_plan_id").eq("org_id", context.orgId).eq("community_id", communityId).eq("is_available", true).order("id").range(from, to),
    { cap: 5_000, label: "Failed to load the plans already offered" },
  )
  if (offered.truncated) throw new Error("This community offers too many plans to list the rest. Withdraw plans it no longer sells first.")
  const offeredIds = [...new Set(offered.rows.map((row) => row.house_plan_id))]

  let query = context.supabase
    .from("house_plans")
    .select("id, code, name, versions:house_plan_versions!inner(status)", { count: "exact" })
    .eq("org_id", context.orgId)
    .neq("status", "retired")
    .eq("versions.status", "released")
  if (offeredIds.length) query = query.not("id", "in", `(${offeredIds.join(",")})`)
  const term = input.search?.trim().replace(/[\\%_,()]/g, "")
  if (term) query = query.or(`code.ilike.%${term}%,name.ilike.%${term}%`)
  const from = (page - 1) * pageSize
  const ordered = query.order("code").order("id")
  const { data, error, count } = await readPageOrEmpty((start, end) => ordered.range(start, end), from, from + pageSize - 1)
  if (error) throw new Error(`Failed to load offerable plans: ${error.message}`)
  return {
    plans: data.map((plan) => ({ id: plan.id, code: plan.code ?? null, name: plan.name })),
    page,
    pageSize,
    total: count ?? 0,
  }
}

/**
 * The base price a plan sells for in one community. Plans decides *which* plans
 * are offered where; this decides what they cost there, because repricing is the
 * sales manager's weekly edit and not an estimating change. A sheet change is a
 * community pricing act (sales.manage, which the database also requires): it is
 * not a per-home price move, so the spec price bands do not apply to it.
 */
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
  const rows = await readAllRowsById((afterId, take) => {
    let query = context.supabase.from("incentives").select("*").eq("org_id", context.orgId).order("id").limit(take)
    if (opts.communityId) query = query.or(`community_id.is.null,community_id.eq.${opts.communityId}`)
    else if (allowedCommunityIds) {
      query = allowedCommunityIds.length > 0
        ? query.or(`community_id.is.null,community_id.in.(${allowedCommunityIds.join(",")})`)
        : query.is("community_id", null)
    }
    if (opts.status) query = query.eq("status", opts.status)
    return afterId ? query.gt("id", afterId) : query
  }, { cap: 2000, label: "Sales incentives", pageSize: 500 })
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id))
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

/** Draft and active agreements hold incentive capacity; the database counts it as they are written. */
async function countIncentiveUses(context: OrgServiceContext, incentiveIds: string[]) {
  const counts = new Map<string, number>()
  if (incentiveIds.length === 0) return counts
  const ids = [...new Set(incentiveIds)]
  const pages = await Promise.all(Array.from({ length: Math.ceil(ids.length / 500) }, async (_, index) => {
    const pageIds = ids.slice(index * 500, (index + 1) * 500)
    const { data, error } = await context.supabase.from("agreement_incentive_capacity")
      .select("incentive_id,used_count").eq("org_id", context.orgId).in("incentive_id", pageIds).limit(pageIds.length)
    if (error || !data || data.length !== pageIds.length) throw new Error("Incentive capacity could not be verified")
    return data
  }))
  for (const row of pages.flat()) {
    const count = typeof row.used_count === "string" && /^[0-9]+$/.test(row.used_count) ? Number(row.used_count) : row.used_count
    if (!ids.includes(row.incentive_id) || counts.has(row.incentive_id) || !Number.isSafeInteger(count) || count < 0) throw new Error("Incentive capacity evidence is invalid")
    counts.set(row.incentive_id, count)
  }
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

/**
 * A spec home's own lines on its agreement. An approved disposition prices the
 * sale at the approved figure (the line is the gap from what the sheet asks) for
 * its own buyer only; it refuses while a below-cost write-down is still
 * unapproved. Otherwise the home's incentive in force comes off the price.
 * These are the home's, not the community's: they never enter `incentives`,
 * whose every id is an `incentives` row the database counts against capacity.
 */
function specHomePriceLines(terms: SpecHomeTerms | null, totalBeforeCents: number): HomePriceAdjustment[] {
  if (!terms) return []
  const disposition = terms.disposition
  if (disposition?.status === "approved") {
    if (disposition.blockedReason) throw new Error(disposition.blockedReason)
    const label = disposition.kind === "bulk_sale" ? "Bulk sale price (approved disposition)" : "Investor sale price (approved disposition)"
    return [{ kind: "disposition", sourceId: disposition.id, label, amountCents: disposition.priceCents - totalBeforeCents }]
  }
  if (terms.incentiveCents > 0 && terms.incentiveId) {
    return [{ kind: "home_incentive", sourceId: terms.incentiveId, label: "Home incentive", amountCents: -terms.incentiveCents }]
  }
  return []
}

export async function priceAgreementDraft(input: AgreementConfigurationInput, orgId?: string) {
  const parsed = agreementConfigurationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: lot, error } = await context.supabase.from("lots").select("id, community_id, project_id, premium_cents, house_plan_id, house_plan_version_id, house_plan_elevation_id, swing, plan:house_plans(name), elevation:house_plan_elevations(name, code)").eq("org_id", context.orgId).eq("id", parsed.lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  await assertCommunityInSalesScope(context, lot.community_id)
  if (lot.project_id) await requireAuthorization({ permission: "sales.read", userId: context.userId, orgId: context.orgId,
    projectId: lot.project_id, supabase: context.supabase })
  const catalogRevision = await readAgreementCatalogRevision(context)
  const versionId = parsed.housePlanVersionId ?? lot.house_plan_version_id
  if (!versionId) throw new Error("Choose a released plan version")
  if (lot.project_id && lot.house_plan_version_id && parsed.housePlanVersionId && parsed.housePlanVersionId !== lot.house_plan_version_id) throw new Error("A spec home's pinned plan version cannot be changed")
  const { data: version, error: versionError } = await context.supabase.from("house_plan_versions").select("id, house_plan_id, status, label, plan:house_plans!inner(name,org_id)").eq("org_id", context.orgId).eq("id", versionId).eq("plan.org_id", context.orgId).maybeSingle()
  if (versionError || !version || version.status !== "released") throw new Error("The selected plan version is not released or could not be verified")
  if (lot.project_id && lot.house_plan_id && version.house_plan_id !== lot.house_plan_id) throw new Error("A pinned home's plan ancestry is inconsistent; reconcile it before writing an agreement")
  const elevationId = parsed.elevationId === undefined ? lot.house_plan_elevation_id ?? null : parsed.elevationId
  if (lot.project_id && lot.house_plan_elevation_id && elevationId !== lot.house_plan_elevation_id) throw new Error("A spec home's pinned elevation cannot be changed")
  let selectedElevation: { name: string | null; code: string } | null = null
  if (elevationId) {
    const elevation = await context.supabase.from("house_plan_elevations").select("id,name,code")
      .eq("org_id", context.orgId).eq("id", elevationId).eq("house_plan_id", version.house_plan_id).eq("is_active", true).maybeSingle()
    if (elevation.error || !elevation.data) throw new Error("The selected elevation is inactive or does not belong to this plan")
    selectedElevation = elevation.data
  }
  const swing = parsed.swing ?? (lot.swing === "left" || lot.swing === "right" ? lot.swing : null)
  if (!swing) throw new Error("Choose a left or right swing before pricing the agreement")
  await assertLotFit(context, { lotId: lot.id, planId: version.house_plan_id, elevationId, swing })
  const offerDate = new Date().toISOString().slice(0, 10)
  let availabilityQuery = context.supabase.from("community_plan_availability").select("base_price_cents").eq("org_id", context.orgId).eq("community_id", lot.community_id).eq("house_plan_id", version.house_plan_id).eq("is_available", true)
  availabilityQuery = elevationId ? availabilityQuery.eq("elevation_id", elevationId) : availabilityQuery.is("elevation_id", null)
  availabilityQuery = availabilityQuery.or(`and(effective_start.is.null,effective_end.is.null),and(effective_start.is.null,effective_end.gte.${offerDate}),and(effective_start.lte.${offerDate},effective_end.is.null),and(effective_start.lte.${offerDate},effective_end.gte.${offerDate})`)
  const { data: availability, error: availabilityError } = await availabilityQuery.maybeSingle()
  if (availabilityError) throw new Error(`Unable to verify effective community pricing: ${availabilityError.message}`)
  if (!availability) throw new Error("This plan and elevation are not available in the community on the quote date")
  const resolved = await resolveOptionPricing({ orgId: context.orgId, items: parsed.optionItems, housePlanVersionId: versionId, communityId: lot.community_id })
  if (resolved.length !== parsed.optionItems.length || resolved.some((item) => !item.available)) throw new Error("One or more configured options are unavailable or could not be fully priced")
  await assertSalesConfiguration(context.orgId, resolved, { communityId: lot.community_id, housePlanVersionId: versionId })
  const optionIds = resolved.map((item) => item.optionId).filter(Boolean) as string[]
  const packageIds = resolved.map((item) => item.packageId).filter(Boolean) as string[]
  const [optionsResult, packagesResult, incentivesResult, homeTerms] = await Promise.all([
    optionIds.length ? context.supabase.from("selection_options").select("id, name, option_scope, category_id, category:selection_categories(name)").eq("org_id", context.orgId).in("id", optionIds) : Promise.resolve({ data: [] }),
    packageIds.length ? context.supabase.from("selection_packages").select("id, name").eq("org_id", context.orgId).in("id", packageIds) : Promise.resolve({ data: [] }),
    parsed.incentiveIds.length ? context.supabase.from("incentives").select("*").eq("org_id", context.orgId).in("id", parsed.incentiveIds) : Promise.resolve({ data: [] }),
    lot.project_id ? readSpecHomeTerms(context, [{ lotId: lot.id, projectId: lot.project_id }]).then((terms) => terms.get(lot.id) ?? null) : Promise.resolve(null),
  ])
  const disposition = homeTerms?.disposition?.status === "approved" ? homeTerms.disposition : null
  if (disposition) {
    // The agreement is written to the lot's live hold or reservation buyer; the disposition's price is that buyer's alone.
    const { data: liveSale, error: liveSaleError } = await context.supabase.from("lot_reservations").select("buyer_contact_id, co_buyer_contact_id")
      .eq("org_id", context.orgId).eq("lot_id", lot.id).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter())
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (liveSaleError) throw new Error(`Failed to verify the home's buyer: ${liveSaleError.message}`)
    if (!liveSale || ![liveSale.buyer_contact_id, liveSale.co_buyer_contact_id].includes(disposition.counterpartyContactId)) {
      throw new Error(`This home is being sold through an approved ${dispositionKindLabel(disposition.kind)} to another buyer. Write the agreement to that buyer, or cancel the disposition to sell it at retail.`)
    }
  }
  const options = optionsResult.data
  const packages = packagesResult.data
  const incentiveRows = incentivesResult.data
  if (("error" in optionsResult && optionsResult.error) || ("error" in packagesResult && packagesResult.error)
    || optionIds.some(id => !options?.some(row => row.id === id)) || packageIds.some(id => !packages?.some(row => row.id === id))
    || options?.some(row => typeof row.name !== "string" || !row.name.trim() || !["structural", "design_studio"].includes(row.option_scope))
    || packages?.some(row => typeof row.name !== "string" || !row.name.trim())) {
    throw new Error("Configured option names and categories could not be fully verified")
  }
  // Signing turns each structural option into the home's selection for its category.
  assertOneStructuralOptionPerCategory((options ?? []).filter(row => row.option_scope === "structural").map(row => ({ name: row.name, categoryId: row.category_id })))
  if ("error" in incentivesResult && incentivesResult.error) throw new Error("Configured incentives could not be verified")
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
  const priced: Array<PurchaseAgreementPricedItem & { scope?: string }> = resolved.map((item: any) => {
    const option = (options ?? []).find((row: any) => row.id === item.optionId)
    const selectionPackage = (packages ?? []).find((row: any) => row.id === item.packageId)
    const category = Array.isArray(option?.category) ? option.category[0] : option?.category
    return { optionId: item.optionId, packageId: item.packageId, label: option?.name ?? selectionPackage?.name ?? "Option", category: category?.name ?? null, priceCents: item.priceCents, source: item.source, scope: option?.option_scope } as PurchaseAgreementPricedItem & { scope?: string }
  })
  const pricingBasis = { basePriceCents: Number(availability.base_price_cents), lotPremiumCents: Number(lot.premium_cents ?? 0), structuralOptions: priced.filter((item) => item.scope === "structural"), designSelections: priced.filter((item) => item.scope !== "structural") }
  const communityIncentives: PurchaseAgreementIncentive[] = requestedIncentives.map((row) => ({ incentiveId: row.id, name: row.name, incentiveType: row.incentive_type, appliesTo: row.applies_to, amountCents: row.amount_cents, percent: row.percent }))
  const pricing = composePurchaseAgreementPricing({ ...pricingBasis, incentives: communityIncentives, homeAdjustments: specHomePriceLines(homeTerms, composePurchaseAgreementPricing({ ...pricingBasis, incentives: communityIncentives }).totalCents) })
  const choicePrices = parsed.optionItems.map((choice, index) => {
    const item = resolved[index]
    if (!item) throw new Error("Configured choices could not be fully priced")
    return { ...choice, priceCents: item.priceCents }
  })
  // The agreement's snapshot carries the disposition it was priced through; carrying the disposition out requires it.
  const quote = { ...pricing, disposition: disposition ? { id: disposition.id, kind: disposition.kind } : null, choicePrices, lotId: lot.id, communityId: lot.community_id, housePlanId: version.house_plan_id, housePlanVersionId: version.id, elevationId, swing, planLabel: (Array.isArray(version.plan) ? version.plan[0] : version.plan)?.name ?? version.label ?? "Plan", elevationLabel: selectedElevation?.name ?? selectedElevation?.code ?? null, optionItems: parsed.optionItems }
  if (await readAgreementCatalogRevision(context) !== catalogRevision) throw new AgreementQuoteChangedError()
  const reviewedQuote = { ...quote, catalogRevision }
  return { ...reviewedQuote, quoteHash: agreementQuoteFingerprint(reviewedQuote) }
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
  pinnedElevationId: string | null
  versions: { id: string; label: string; isPinned: boolean }[]
  elevations: { id: string; label: string }[]
  structuralOptions: AgreementCatalogItem[]
  designSelections: AgreementCatalogItem[]
  packages: AgreementCatalogItem[]
  incentives: { id: string; name: string; summary: string }[]
  /** The org's documents this home is sold on, or why there are none to sell it on. */
  packet: ResolvedAgreementPacket | null
  packetRefusal: string | null
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

  const { data: reservation, error: reservationError } = await context.supabase
    .from("lot_reservations")
    .select(
      "id, status, lot_id, community_id, buyer_contact_id, buyer:contacts!lot_reservations_buyer_contact_id_fkey(full_name, email), lot:lots(id, community_id, project_id, house_plan_id, house_plan_version_id, house_plan_elevation_id, swing, block, lot_number, plan:house_plans(name), elevation:house_plan_elevations(name, code))",
    )
    .eq("org_id", context.orgId)
    .eq("id", reservationId)
    .maybeSingle()
  if (reservationError || !reservation) throw new Error("Reservation not found or could not be verified")
  if (reservation.status !== "reserved") {
    throw new Error("Take the reservation first — an agreement needs a reserved lot")
  }
  const lot = Array.isArray(reservation.lot) ? reservation.lot[0] : reservation.lot
  if (!lot) throw new Error("Reservation is not attached to a lot")
  if (!lot.house_plan_id) throw new Error("Assign a plan to the lot before writing the agreement")
  await assertCommunityInSalesScope(context, lot.community_id)
  if (lot.project_id) await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId,
    projectId: lot.project_id, supabase: context.supabase })

  const buyer = Array.isArray(reservation.buyer) ? reservation.buyer[0] : reservation.buyer
  const plan = Array.isArray(lot.plan) ? lot.plan[0] : lot.plan
  const elevation = Array.isArray(lot.elevation) ? lot.elevation[0] : lot.elevation

  const [versions, elevations, catalog, incentiveRows, packetResolution] = await Promise.all([
    readAllRowsById((afterId, take) => {
      const query = context.supabase.from("house_plan_versions").select("id, label, released_at")
        .eq("org_id", context.orgId).eq("house_plan_id", lot.house_plan_id).eq("status", "released")
        .order("id").limit(take)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: 2000, label: "Agreement plan versions", pageSize: 500 }),
    readAllRowsById((afterId, take) => {
      const query = context.supabase.from("house_plan_elevations").select("id, name, code")
        .eq("org_id", context.orgId).eq("house_plan_id", lot.house_plan_id).eq("is_active", true)
        .order("id").limit(take)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: 2000, label: "Agreement elevations", pageSize: 500 }),
    listCatalog({ communityId: lot.community_id }, context.orgId),
    listIncentives({ communityId: lot.community_id, status: "active", eligibleOnly: true }, context.orgId),
    resolveHomePacket(context, lot.community_id, []).then(
      (packet) => ({ packet, refusal: null }),
      (error: unknown) => {
        if (error instanceof AgreementPacketError) return { packet: null, refusal: error.message }
        throw error
      },
    ),
  ])
  versions.sort((a, b) => (b.released_at ?? "").localeCompare(a.released_at ?? "") || a.id.localeCompare(b.id))
  elevations.sort((a, b) => (a.name ?? a.code ?? "").localeCompare(b.name ?? b.code ?? "") || a.id.localeCompare(b.id))
  if (lot.project_id && lot.house_plan_version_id && !versions.some(row => row.id === lot.house_plan_version_id)) throw new Error("The home's pinned plan version is no longer released; reconcile it before preparing an agreement")
  if (lot.project_id && lot.house_plan_elevation_id && !elevations.some(row => row.id === lot.house_plan_elevation_id)) throw new Error("The home's pinned elevation is no longer active; reconcile it before preparing an agreement")

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
    pinnedElevationId: lot.project_id ? lot.house_plan_elevation_id ?? null : null,
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
    packet: packetResolution.packet,
    packetRefusal: packetResolution.refusal,
  }
}

/** The packet a home in this community resolves to now, with the optional addenda on offer. */
async function resolveHomePacket(context: OrgServiceContext, communityId: string, optionalTemplateIds: string[]): Promise<ResolvedAgreementPacket> {
  const { data, error } = await createServiceSupabaseClient().rpc("resolve_agreement_packet", {
    p_org_id: context.orgId, p_community_id: communityId, p_optional_template_ids: optionalTemplateIds,
  })
  const refusal = agreementPacketRefusal(error)
  if (refusal) throw refusal
  if (error) throw new Error(`The agreement documents could not be resolved: ${error.message}`)
  return resolvedAgreementPacketSchema.parse(data)
}

const packetPreviewSchema = z.union([
  z.object({ lotId: z.string().uuid(), optionalAddendumTemplateIds: z.array(z.string().uuid()).max(50).default([]) }),
  z.object({ contractId: z.string().uuid(), optionalAddendumTemplateIds: z.array(z.string().uuid()).max(50).default([]) }),
])

/**
 * The documents a sale on this home would be signed on: the agreement form
 * shows it while the seller picks optional addenda, and a draft whose packet
 * went stale shows it before refreshing. The hash is what creation and refresh
 * are then checked against.
 */
export async function previewAgreementPacket(input: unknown, orgId?: string): Promise<{ packet: ResolvedAgreementPacket; current: AgreementPacket | null }> {
  const parsed = packetPreviewSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  let lotId: string
  let current: AgreementPacket | null = null
  if ("contractId" in parsed) {
    const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status, snapshot")
      .eq("org_id", context.orgId).eq("id", parsed.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
    if (error || !contract) throw new Error("Purchase agreement not found")
    const saved = z.object({ purchase_agreement: z.object({ configuration: z.object({ lot_id: z.string().uuid() }), packet: agreementPacketSchema.optional() }) }).safeParse(contract.snapshot)
    if (!saved.success) throw new Error("The saved agreement configuration needs reconciliation")
    lotId = saved.data.purchase_agreement.configuration.lot_id
    current = saved.data.purchase_agreement.packet ?? null
  } else {
    lotId = parsed.lotId
  }
  const { data: lot, error: lotError } = await context.supabase.from("lots").select("id, community_id, project_id").eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (lotError || !lot) throw new Error("Lot not found")
  await assertCommunityInSalesScope(context, lot.community_id)
  if (lot.project_id) await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId, projectId: lot.project_id, supabase: context.supabase })
  return { packet: await resolveHomePacket(context, lot.community_id, parsed.optionalAddendumTemplateIds), current }
}

/**
 * Write the draft agreement in one transaction (`create_purchase_agreement_atomic`):
 * the contract, its reservation, the home's configuration, the packet it will be
 * signed on, the event, the audit row and an immutable receipt. A retry with
 * the same reviewed request recovers the saved sale instead of writing another.
 */
export async function createPurchaseAgreement(input: unknown, orgId?: string) {
  const parsed = createPurchaseAgreementSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const request = { ...parsed, terms: parsed.terms ?? null }
  const base = { orgId: context.orgId, actorId: context.userId, reservationId: parsed.reservationId, request }
  let receipt = await saveAgreementCreation(base)
  if (!receipt) {
    const { data: reservation, error } = await context.supabase.from("lot_reservations").select("*, lot:lots(*)")
      .eq("org_id", context.orgId).eq("id", parsed.reservationId).maybeSingle()
    if (error || !reservation || reservation.status !== "reserved" || reservation.contract_id || !reservation.lot?.project_id) throw new Error("Unowned reserved lot with an actual home is required")
    if (reservation.lot_id !== parsed.lotId) throw new Error("Reservation and lot do not match")
    await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId,
      projectId: reservation.lot.project_id, supabase: context.supabase })
    const expectedFacts = agreementCreationExpected(reservation, reservation.lot)
    const [pricing, resolved] = await Promise.all([
      priceAgreementDraft(parsed, context.orgId),
      resolveHomePacket(context, reservation.lot.community_id, parsed.optionalAddendumTemplateIds),
    ])
    if (pricing.quoteHash !== parsed.expectedQuoteHash) throw new AgreementQuoteChangedError()
    const packet = storedAgreementPacket(resolved)
    if (packet.hash !== parsed.expectedPacketHash) throw new AgreementPacketError("AGREEMENT_PACKET_CHANGED", describeAgreementPacketRefusal("AGREEMENT_PACKET_CHANGED"))
    const expected = { ...expectedFacts, catalog_revision: pricing.catalogRevision }
    const snapshot = { purchase_agreement: { version: 1, configuration: {
      lot_id: parsed.lotId, house_plan_id: pricing.housePlanId, house_plan_version_id: pricing.housePlanVersionId,
      elevation_id: pricing.elevationId, swing: pricing.swing, option_items: pricing.optionItems,
    }, pricing, packet, deposits: reservation.deposit_invoice_id ? [{ invoice_id: reservation.deposit_invoice_id, kind: "earnest_deposit" }] : [], incentive_ids: parsed.incentiveIds,
    financing: parsed.financing, contingencies: parsed.contingencies } }
    receipt = await saveAgreementCreation({ ...base, expected, snapshot })
    if (!receipt) throw new Error("Agreement creation receipt was not returned; reconcile the sale before retrying")
  }
  return finishReceiptedPurchaseAgreement(receipt, context)
}

async function finishReceiptedPurchaseAgreement(receipt: AgreementCreationReceipt, context: OrgServiceContext) {
  const contract = receipt.contract
  await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId, projectId: contract.project_id, supabase: context.supabase })
  let signing: { documentId: string | null; envelopeId: string | null; reason: string | null }
  if (contract.status !== "draft") {
    signing = { documentId: null, envelopeId: null, reason: "The existing agreement was recovered. Review its current status before preparing signatures." }
  } else {
    try {
      signing = await generatePurchaseAgreementSigningDocument(contract.id, context.orgId, { expectedProjectId: contract.project_id })
    } catch (error) {
      try {
        logger.warn("agreement_signing_preparation_unconfirmed", { domain: "sales", orgId: context.orgId, projectId: contract.project_id,
          contractId: contract.id, receiptId: receipt.receipt_id, errorType: error instanceof Error ? error.name : "Unknown" })
      } catch { /* Telemetry failure must not obscure the committed sale. */ }
      signing = { documentId: null, envelopeId: null, reason: "The agreement was saved. Signing preparation could not be confirmed; review its signing status and resume the saved packet." }
    }
  }
  return { ...contract, pricing: contract.snapshot.purchase_agreement.pricing as AgreementDraftPricing, signing,
    creationReceiptId: receipt.receipt_id, recovered: !receipt.created }
}

/** Resume only after proving the saved sale owns its reservation and home configuration. */
export async function resumePurchaseAgreementSigning(input: unknown, orgId?: string) {
  const parsed = z.object({ contractId: z.string().uuid(), projectId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("id,project_id,status,snapshot")
    .eq("org_id", context.orgId).eq("id", parsed.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract || contract.project_id !== parsed.projectId || contract.status !== "draft") throw new Error("The draft agreement or home changed. Reload before resuming signatures.")
  await requireAuthorization({permission:"sales.manage",orgId:context.orgId,userId:context.userId,projectId:contract.project_id,supabase:context.supabase})
  const snapshot = z.object({ purchase_agreement: z.object({ configuration: z.object({
    lot_id: z.string().uuid(), house_plan_id: z.string().uuid().nullable(), house_plan_version_id: z.string().uuid().nullable(),
    elevation_id: z.string().uuid().nullable(), swing: z.enum(["left","right"]),
  }) }) }).safeParse(contract.snapshot)
  if (!snapshot.success) throw new Error("The saved agreement configuration needs reconciliation before signing")
  const configuration = snapshot.data.purchase_agreement.configuration
  const [lot,reservations] = await Promise.all([
    context.supabase.from("lots").select("project_id,status,house_plan_id,house_plan_version_id,house_plan_elevation_id,swing")
      .eq("org_id",context.orgId).eq("id",configuration.lot_id).maybeSingle(),
    context.supabase.from("lot_reservations").select("id,lot_id,status").eq("org_id",context.orgId)
      .eq("contract_id",contract.id).limit(2),
  ])
  if (lot.error || !lot.data || reservations.error || reservations.data?.length !== 1 || reservations.data[0].lot_id !== configuration.lot_id || reservations.data[0].status !== "reserved" || lot.data.project_id !== contract.project_id
    || !SELLABLE_LOT_STATUSES.includes(lot.data.status) || lot.data.house_plan_id !== configuration.house_plan_id || lot.data.house_plan_version_id !== configuration.house_plan_version_id
    || lot.data.house_plan_elevation_id !== configuration.elevation_id || lot.data.swing !== configuration.swing) throw new Error("The saved agreement, reservation and home configuration need reconciliation before signing")
  return generatePurchaseAgreementSigningDocument(contract.id,context.orgId,{expectedProjectId:parsed.projectId})
}

/**
 * A draft whose packet went stale before its signing document was prepared (a
 * version was withdrawn, or a new required addendum was published) takes the
 * packet the seller just reviewed, then signing is prepared on it.
 */
export async function refreshPurchaseAgreementPacket(input: unknown, orgId?: string) {
  const parsed = refreshAgreementPacketSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status")
    .eq("org_id", context.orgId).eq("id", parsed.contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract) throw new Error("Purchase agreement not found")
  if (contract.status !== "draft") throw new Error("A signed or voided agreement's documents cannot change. Amend a signed agreement with a change order.")
  await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId, projectId: contract.project_id, supabase: context.supabase })
  const { data, error: refreshError } = await createServiceSupabaseClient().rpc("refresh_purchase_agreement_packet", {
    p_org_id: context.orgId, p_contract_id: contract.id, p_actor_id: context.userId,
    p_optional_template_ids: parsed.optionalAddendumTemplateIds, p_expected_hash: parsed.expectedPacketHash,
  })
  const refusal = agreementPacketRefusal(refreshError)
  if (refusal) throw refusal
  if (refreshError) throw new Error(refreshError.message)
  const packet = agreementPacketSchema.parse(data)
  const signing = await generatePurchaseAgreementSigningDocument(contract.id, context.orgId, { expectedProjectId: contract.project_id })
  return { packet, signing }
}

const signingSnapshotSchema = z.object({ purchase_agreement: z.object({
  configuration: z.object({ lot_id: z.string().uuid(), swing: z.enum(["left", "right"]) }).passthrough(),
  pricing: z.object({ totalCents: z.number().int(), planLabel: z.string().optional(), elevationLabel: z.string().nullable().optional() }).passthrough(),
  packet: agreementPacketSchema,
  // Drafts written before financing was captured seed as financed with no contingencies; so do they print.
  financing: z.enum(["cash", "financed"]).default("financed"),
  contingencies: z.array(agreementContingencySchema).default([]),
}) })

/**
 * Why signing cannot be prepared for this draft yet, each in the seller's
 * words. Every precondition that is decided outside the signing transaction
 * belongs here, so the seller sees all of them at once and no envelope is
 * reserved for an agreement that cannot be signed.
 */
async function agreementSigningRefusals(context: OrgContext, contract: { id: string; snapshot: unknown }): Promise<string[]> {
  const snapshot = signingSnapshotSchema.safeParse(contract.snapshot)
  const refusals = snapshot.success ? [] : [describeAgreementPacketRefusal("AGREEMENT_PACKET_STALE")]
  const commission = await commissionSigningRefusal(context.supabase, context.orgId, contract.id)
  return commission ? [...refusals, commission] : refusals
}

export async function generatePurchaseAgreementSigningDocument(contractId: string, orgId?: string, options: { expectedProjectId?: string } = {}) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("*, project:projects(name)").eq("org_id", context.orgId).eq("id", contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error || !contract) throw new Error("Purchase agreement not found")
  if (options.expectedProjectId && contract.project_id !== options.expectedProjectId) throw new Error("The agreement home changed. Reload before resuming signatures.")
  await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId,
    projectId: contract.project_id, supabase: context.supabase })
  if (contract.status !== "draft") throw new Error("Only a draft purchase agreement can be prepared for signature")
  if (getFilesStorageProvider() !== "r2") return { documentId: null, envelopeId: null, reason: "Document signing storage is not configured" }
  if (!process.env.DOCUMENT_SIGNING_SECRET) throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  if (!contract.buyer_contact_id) throw new Error("The agreement needs a buyer of record before signing")
  if (contract.co_buyer_contact_id === contract.buyer_contact_id) throw new Error("Buyer and co-buyer must be different contacts")
  const refusals = await agreementSigningRefusals(context, contract)
  if (refusals.length > 0) return { documentId: null, envelopeId: null, reason: refusals.join(" ") }
  let owned: Awaited<ReturnType<typeof reserveAgreementSigningDocument>>
  try {
    owned = await reserveAgreementSigningDocument({ orgId: context.orgId, actorId: context.userId, contract })
  } catch (reserveError) {
    if (reserveError instanceof AgreementPacketError) return { documentId: null, envelopeId: null, reason: reserveError.message }
    throw reserveError
  }
  if (owned) return publishOwnedAgreementDocument({ orgId: context.orgId, actorId: context.userId, document: owned })
  const contactIds = [contract.buyer_contact_id, ...(contract.co_buyer_contact_id ? [contract.co_buyer_contact_id] : [])]
  const snapshot = signingSnapshotSchema.parse(contract.snapshot).purchase_agreement
  const pricing: PurchaseAgreementPricing = contract.snapshot.purchase_agreement.pricing
  const [contactsResult, builderResult, lotResult, branding, documents] = await Promise.all([
    context.supabase.from("contacts").select("id, full_name, email").eq("org_id", context.orgId).in("id", contactIds),
    context.supabase.from("app_users").select("id, full_name, email").eq("id", context.userId).maybeSingle(),
    context.supabase.from("lots").select("lot_number, block, address, community:communities(name)").eq("org_id", context.orgId).eq("id", snapshot.configuration.lot_id).maybeSingle(),
    getOrgBranding(context.orgId, context.supabase),
    loadAgreementPacketDocuments(context.orgId, snapshot.packet.documents),
  ])
  if (contactsResult.error || contactsResult.data?.length !== contactIds.length) throw new Error("Agreement signer contacts could not be verified in this organization")
  if (builderResult.error) throw new Error("The builder signer could not be verified")
  if (lotResult.error || !lotResult.data) throw new Error("The agreement's lot could not be verified")
  const buyer = contactsResult.data.find((contact) => contact.id === contract.buyer_contact_id)
  const coBuyer = contract.co_buyer_contact_id ? contactsResult.data.find((contact) => contact.id === contract.co_buyer_contact_id) : null
  const builder = builderResult.data
  if (!buyer?.email) throw new Error("Buyer email is required before creating a signing envelope")
  if (contract.co_buyer_contact_id && !coBuyer?.email) throw new Error("Co-buyer email is required before creating a signing envelope")
  if (!builder?.email) throw new Error("The builder signer needs an email address")
  const lot = lotResult.data
  const community = Array.isArray(lot.community) ? lot.community[0] : lot.community
  const scheduleA = buildScheduleA({
    agreementNumber: contract.number ?? contract.id, effectiveDate: contract.effective_date ?? null,
    buyer: { name: buyer.full_name, email: buyer.email }, coBuyer: coBuyer ? { name: coBuyer.full_name, email: coBuyer.email ?? null } : null,
    community: community?.name ?? null, lot: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number ?? null, address: lot.address ?? null,
    plan: snapshot.pricing.planLabel ?? null, elevation: snapshot.pricing.elevationLabel ?? null, swing: snapshot.configuration.swing,
    pricing, stipulations: contract.terms ?? null, financing: snapshot.financing, contingencies: snapshot.contingencies,
  })
  const pdf = await renderPurchaseAgreementPacket({
    orgName: branding.name ?? "Builder", title: contract.title, scheduleA, documents, packetHash: snapshot.packet.hash,
    signers: [{ role: "Buyer", name: buyer.full_name }, ...(coBuyer ? [{ role: "Co-buyer", name: coBuyer.full_name }] : []), { role: branding.name ?? "Builder", name: builder.full_name }],
  })
  const fileName = `purchase-agreement-${contract.number ?? contract.id}.pdf`.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(context.orgId, "projects", contract.project_id, "esign", "source", `${randomUUID()}_${fileName}`)
  await uploadFilesObject({ supabase: context.supabase, orgId: context.orgId, path: storagePath, bytes: pdf, contentType: "application/pdf", upsert: false })
  const file = await createFileRecord({ project_id: contract.project_id, file_name: fileName, storage_path: storagePath, mime_type: "application/pdf", size_bytes: pdf.length, checksum: createHash("sha256").update(pdf).digest("hex"), visibility: "private", category: "contracts", folder_path: "/contracts", source: "generated" }, context.orgId, { authorizationPermission: "sales.manage" })
  const recipients = [
    { type: "contact", contact_id: buyer.id, user_id: null, name: buyer.full_name, email: buyer.email, role: "signer", signer_role: "buyer", sequence: 1, required: true },
    ...(coBuyer?.email ? [{ type: "contact", contact_id: coBuyer.id, user_id: null, name: coBuyer.full_name, email: coBuyer.email, role: "signer", signer_role: "co_buyer", sequence: 1, required: true }] : []),
    { type: "internal_user", contact_id: null, user_id: builder.id, name: builder.full_name, email: builder.email, role: "signer", signer_role: "builder", sequence: 2, required: true },
  ]
  // Probe and reservation share contract ownership; a concurrent winner is
  // resumed instead of replacing its file, builder signer or invitation IDs.
  const reserved = await reserveAgreementSigningDocument({ orgId: context.orgId, actorId: context.userId, contract, fileId: file.id, recipients })
  if (!reserved) throw new Error("Agreement signing document reservation is missing. Reconcile before retrying.")
  return publishOwnedAgreementDocument({ orgId: context.orgId, actorId: context.userId, document: reserved })
}

export async function hasExecutedPurchaseAgreement(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase.from("contracts").select("id").eq("org_id", context.orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").eq("status", "active").limit(1).maybeSingle()
  if (error) throw new Error(`Failed to check purchase agreement: ${error.message}`)
  // An agreement brought over at cutover counts once its executed copy is on file or a person has accepted it.
  return Boolean(data) && !(await importedAgreementEvidenceMissing(context.supabase, context.orgId, projectId))
}

const purchaseAgreementSnapshotSchema = z.object({ purchase_agreement: z.object({ pricing: z.object({
  structuralOptions: z.array(z.object({ optionId: z.string().optional(), label: z.string(), priceCents: z.number().int() })),
}) }) })

/**
 * The structural options the buyer signed for become the home's confirmed,
 * locked selections, so purchasing and the budget buy them like any other
 * confirmed choice. Re-running on recovery writes the same rows.
 */
async function recordAgreementStructuralSelections(supabase: SupabaseClient, input: { orgId: string; projectId: string; contractId: string; snapshot: unknown; now: string }) {
  const snapshot = purchaseAgreementSnapshotSchema.parse(input.snapshot)
  const pricing = snapshot.purchase_agreement.pricing
  if (pricing.structuralOptions.length === 0) return
  const { data: lot, error } = await supabase.from("lots").select("community_id, house_plan_version_id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle()
  if (error) throw new Error(`Purchase agreement execution failed: ${error.message}`)
  // Cost resolves the way a design-studio choice's does: plan and community
  // prices first. Availability is not re-checked; the buyer has signed for it.
  const items = pricing.structuralOptions.flatMap((item) => item.optionId ? [{ optionId: item.optionId, name: item.label }] : [])
  const resolved = items.length ? await resolveOptionPricing({ orgId: input.orgId, items: items.map(({ optionId }) => ({ optionId })),
    housePlanVersionId: lot?.house_plan_version_id ?? undefined, communityId: lot?.community_id ?? undefined, requirePlanVersion: Boolean(lot?.community_id) }) : []
  const selections = agreementStructuralSelections(pricing, resolved.flatMap((row, index) => row.categoryId
    ? [{ id: items[index].optionId, name: items[index].name, categoryId: row.categoryId, costCents: row.costCents }] : []))
  const { error: writeError } = await supabase.from("project_selections").upsert(selections.map((selection) => ({
    org_id: input.orgId, project_id: input.projectId, category_id: selection.categoryId, selected_option_id: selection.optionId,
    status: "confirmed", selected_at: input.now, confirmed_at: input.now, locked_at: input.now,
    price_cents_snapshot: selection.priceCents, cost_cents_snapshot: selection.costCents,
    metadata: { source: "purchase_agreement", contract_id: input.contractId },
  })), { onConflict: "project_id,category_id" })
  if (writeError) throw new Error(`Purchase agreement execution failed: ${writeError.message}`)
}

/**
 * What signing locks on the home. The policy (LOT-01 D1): a signature commits
 * the structure of the house, not its finishes — structural selections (written
 * locked above) and any choice already confirmed lock now; design selections
 * stay open until their own group cutoff. To lock everything at signing instead,
 * drop the status filter.
 */
async function lockSelectionsAtSigning(supabase: SupabaseClient, input: { orgId: string; projectId: string; now: string }) {
  const { error } = await supabase.from("project_selections").update({ locked_at: input.now }).eq("org_id", input.orgId).eq("project_id", input.projectId)
    .is("locked_at", null).in("status", ["confirmed", "ordered", "received"])
  if (error) throw new Error(`Purchase agreement execution failed: ${error.message}`)
}


export async function executePurchaseAgreementFromEnvelopeExecution(input: { orgId: string; contractId: string; envelopeId: string; executedFileId?: string | null }) {
  const supabase = createServiceSupabaseClient()
  const checked = <T extends { error: { message: string } | null }>(result: T): T => {
    if (result.error) throw new Error(`Purchase agreement execution failed: ${result.error.message}`)
    return result
  }
  const { data: contract } = checked(await supabase.from("contracts").select("*, project:projects(end_date)").eq("org_id", input.orgId).eq("id", input.contractId).eq("contract_type", "purchase_agreement").maybeSingle())
  if (!contract) throw new Error("Purchase agreement not found")
  if (contract.status === "void") throw new Error("Purchase agreement was voided")
  if (contract.status === "active" && contract.signature_data?.execution_effects_completed === true) return
  const now = contract.signed_at ?? new Date().toISOString()
  // The signature binds the packet the buyer was shown and the exact bytes they signed.
  const { data: signingDocument } = checked(await supabase.from("documents").select("metadata").eq("org_id", input.orgId)
    .eq("source_entity_type", "contract").eq("source_entity_id", contract.id).contains("metadata", { purchase_agreement: true }).maybeSingle())
  const signatureData = { ...(contract.signature_data ?? {}), envelope_id: input.envelopeId, executed_file_id: input.executedFileId ?? null,
    packet_hash: contract.snapshot?.purchase_agreement?.packet?.hash ?? null, source_sha256: signingDocument?.metadata?.esign_source?.sha256 ?? null }
  // Execution binds the org's default warranty program, so an org that has never opened the warranty desk has one to bind.
  await ensureWarrantyDefaults(input.orgId)
  checked(await supabase.from("contracts").update({ status: "active", signed_at: now, signature_data: signatureData }).eq("org_id", input.orgId).eq("id", contract.id))
  const { data: projectLot } = checked(await supabase.from("lots").select("id, community_id, status").eq("org_id", input.orgId).eq("project_id", contract.project_id).maybeSingle())
  if (projectLot) {
    checked(await supabase.from("lot_reservations").update({ status: "converted", converted_at: now, contract_id: contract.id }).eq("org_id", input.orgId).eq("lot_id", projectLot.id).eq("status", "reserved"))
    // Recovery must also find the reservation converted by an earlier attempt.
    const { data: reservations } = checked(await supabase.from("lot_reservations").select("prospect_id").eq("org_id", input.orgId).eq("contract_id", contract.id).eq("status", "converted"))
    for (const reservation of reservations ?? []) {
      if (reservation.prospect_id) checked(await supabase.from("prospects").update({ status: "won", won_at: now, lost_at: null, lost_reason: null, updated_at: now }).eq("org_id", input.orgId).eq("id", reservation.prospect_id).neq("status", "won"))
    }
  }
  await instantiateSelectionGroupsForProject(contract.project_id, input.orgId)
  await recordAgreementStructuralSelections(supabase, { orgId: input.orgId, projectId: contract.project_id, contractId: contract.id, snapshot: contract.snapshot, now })
  await lockSelectionsAtSigning(supabase, { orgId: input.orgId, projectId: contract.project_id, now })
  if (projectLot) {
    const { data: existingClosing } = checked(await supabase.from("closings").select("id").eq("org_id", input.orgId).eq("project_id", contract.project_id).neq("status", "cancelled").maybeSingle())
    if (!existingClosing) checked(await supabase.from("closings").insert({ org_id: input.orgId, project_id: contract.project_id, lot_id: projectLot.id, community_id: projectLot.community_id, status: "projected", scheduled_date: contract.project?.end_date ?? null, buyer_contact_id: contract.buyer_contact_id ?? null }))
  }
  // What the home was sold at, from the selections just costed and locked, and
  // the plan, elevation and option revisions it was priced against. A
  // recovered execution finds both already captured.
  await Promise.all([
    captureHomeMarginBaseline({ orgId: input.orgId, projectId: contract.project_id, stage: "agreement" }),
    captureHomeProductRevisions({ orgId: input.orgId, projectId: contract.project_id, stage: "agreement" }),
  ])
  await Promise.all([
    recordEvent({ orgId: input.orgId, eventType: "purchase_agreement_executed", entityType: "contract", entityId: contract.id, payload: { project_id: contract.project_id, envelope_id: input.envelopeId, packet_hash: signatureData.packet_hash } }),
    recordAudit({ orgId: input.orgId, action: "update", entityType: "contract", entityId: contract.id, after: { status: "active", signed_at: now, packet_hash: signatureData.packet_hash, source_sha256: signatureData.source_sha256 } }),
  ])
  checked(await supabase.from("contracts").update({ signature_data: { ...signatureData, execution_effects_completed: true } }).eq("org_id", input.orgId).eq("id", contract.id))
}

const cents = z.union([z.number(), z.string().regex(/^-?[0-9]+$/)]).transform(Number).pipe(z.number().int())
const planLineSchema = z.object({ id: z.string().uuid(), title: z.string().nullable(), total_cents: cents.nullable(), status: z.string().optional() })

export const agreementCancellationPlanSchema = z.object({
  contract: z.object({ id: z.string().uuid(), status: z.enum(["draft", "active"]), number: z.string().nullable(), project_id: z.string().uuid() }),
  blocked: z.string().nullable(),
  closing: z.object({ id: z.string().uuid(), status: z.string() }).nullable(),
  reservation: z.object({ id: z.string().uuid(), status: z.string(), deposit_invoice_id: z.string().uuid().nullable(), prospect_id: z.string().uuid().nullable() }).nullable(),
  deposit: z.object({
    collected_cents: cents, refunded_cents: cents, applied_cents: cents, available_cents: cents,
    payments: z.array(z.object({ payment_id: z.string().uuid(), invoice_id: z.string().uuid(), amount_cents: cents, refunded_cents: cents, applied_cents: cents, available_cents: cents })),
  }),
  envelopes: z.array(z.object({ id: z.string().uuid(), status: z.string(), source_entity_type: z.string().nullable(), source_entity_id: z.string().uuid().nullable() })),
  pending_change_orders: z.array(z.object({ id: z.string().uuid(), co_number: z.number().int().nullable(), title: z.string().nullable(), total_cents: cents.nullable() })),
  amendments: z.object({ count: cents, total_cents: cents }),
  variance_orders: z.object({ to_void: z.array(planLineSchema), kept: z.array(planLineSchema) }),
  start_package: z.object({ id: z.string().uuid(), status: z.string(), action: z.enum(["returns_to_open", "keeps_building"]) }).nullable(),
  selections: z.object({ unlock: cents, keep_locked: cents }),
  incentives: cents,
  portal_tokens: cents,
})

/** What cancelling a sale will do, reviewed before it is confirmed. `hash` is what the confirmation must name. */
export type AgreementCancellationPlan = z.infer<typeof agreementCancellationPlanSchema> & { hash: string }

const cancellationRowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  reservation_id: z.string().uuid().nullable(),
  reason: z.string(),
  deposit_disposition: z.enum(["refund", "forfeit", "split", "none"]),
  forfeit_cents: cents,
  refund_cents: cents,
  plan: agreementCancellationPlanSchema,
  outcomes: z.record(z.unknown()),
  settlement_status: z.enum(["pending", "settling", "completed", "failed"]),
  settlement_error: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
})

export type AgreementCancellation = {
  id: string
  contractId: string
  projectId: string
  reason: string
  depositDisposition: "refund" | "forfeit" | "split" | "none"
  forfeitCents: number
  refundCents: number
  settlementStatus: "pending" | "settling" | "completed" | "failed"
  settlementError: string | null
  completedAt: string | null
  createdAt: string
}

function cancellationDto(row: z.infer<typeof cancellationRowSchema>): AgreementCancellation {
  return {
    id: row.id, contractId: row.contract_id, projectId: row.project_id, reason: row.reason,
    depositDisposition: row.deposit_disposition, forfeitCents: row.forfeit_cents, refundCents: row.refund_cents,
    settlementStatus: row.settlement_status, settlementError: row.settlement_error, completedAt: row.completed_at, createdAt: row.created_at,
  }
}

/** A coded refusal the dialog answers by reloading the plan. */
export class AgreementCancellationChangedError extends Error {
  readonly code = "AGREEMENT_CANCELLATION_CHANGED"
  constructor() { super("The sale changed since you reviewed the cancellation. Review it again.") }
}

async function readCancellationPlan(context: OrgServiceContext, contractId: string): Promise<AgreementCancellationPlan> {
  const { data, error } = await createServiceSupabaseClient().rpc("preview_purchase_agreement_cancellation", { p_org_id: context.orgId, p_contract_id: contractId })
  if (error) throw new Error(error.message)
  const hash = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(data).hash
  return { ...agreementCancellationPlanSchema.parse(data), hash }
}

async function loadCancellableAgreement(context: OrgServiceContext, contractId: string) {
  const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status")
    .eq("org_id", context.orgId).eq("id", contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error) throw new Error(`Failed to load purchase agreement: ${error.message}`)
  if (!contract || !["draft", "active"].includes(contract.status)) throw new Error("Active purchase agreement not found")
  await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId, projectId: contract.project_id, supabase: context.supabase })
  return contract
}

/**
 * Everything cancelling this sale would touch: the money (collected, already
 * refunded or applied, available), open signing envelopes, unsigned change
 * orders and the buyer variance orders behind them, executed amendments that
 * stay on record, the start package, which selections unlock and which stay
 * with the house, and the buyer's portal access.
 */
export async function previewAgreementCancellation(contractId: string, orgId?: string): Promise<AgreementCancellationPlan> {
  z.string().uuid().parse(contractId)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  const contract = await loadCancellableAgreement(context, contractId)
  return readCancellationPlan(context, contract.id)
}

/**
 * Cancel a sale. The void and every reconciliation the seller reviewed commit
 * in one transaction (`void_purchase_agreement_atomic`) against the plan's hash,
 * so two cancellations racing on one agreement cannot both run and a plan that
 * changed underneath is refused. A settled sale is refused: reverse its closing
 * first. The money (refund, forfeiture or a split of the two, never more than
 * is still available) and the buyer's portal access are then settled from the
 * cancellation receipt, and a failed step is retried from there.
 */
export async function voidPurchaseAgreement(input: unknown, orgId?: string) {
  const parsed = voidPurchaseAgreementSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await requirePermission("project.manage", context)
  const contract = await loadCancellableAgreement(context, parsed.contractId)
  const plan = await readCancellationPlan(context, contract.id)
  if (plan.blocked) throw new Error(plan.blocked)
  if (plan.hash !== parsed.expectedPlanHash) throw new AgreementCancellationChangedError()
  // Moving the deposit needs release authority; refuse before the fence, not after it.
  if (plan.deposit.available_cents > 0) await requirePermission("payment.release", context)

  const { data, error } = await createServiceSupabaseClient().rpc("void_purchase_agreement_atomic", {
    p_org_id: context.orgId, p_contract_id: contract.id, p_actor_id: context.userId, p_reason: parsed.reason,
    p_deposit_disposition: parsed.depositDisposition, p_forfeit_cents: parsed.forfeitCents ?? null, p_expected_plan_hash: parsed.expectedPlanHash,
  })
  if (error?.details === "AGREEMENT_CANCELLATION_CHANGED") throw new AgreementCancellationChangedError()
  if (error) throw new Error(error.message)
  const cancellation = cancellationRowSchema.parse(z.object({ cancellation: z.unknown() }).parse(data).cancellation)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "purchase_agreement_voided", entityType: "contract", entityId: contract.id,
      payload: { reason: parsed.reason, cancellation_id: cancellation.id, deposit_disposition: cancellation.deposit_disposition, forfeit_cents: cancellation.forfeit_cents, refund_cents: cancellation.refund_cents } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "contract", entityId: contract.id,
      before: { status: contract.status }, after: { status: "void", cancellation_id: cancellation.id, reason: parsed.reason, deposit_disposition: cancellation.deposit_disposition }, critical: true }),
    ...(cancellation.reservation_id ? [
      recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_reservation_released", entityType: "lot_reservation", entityId: cancellation.reservation_id,
        payload: { reason: parsed.reason, deposit_disposition: cancellation.deposit_disposition, cancellation_id: cancellation.id } }),
      recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot_reservation", entityId: cancellation.reservation_id,
        after: { status: "released", cancellation_id: cancellation.id } }),
    ] : []),
  ])
  return settleAgreementCancellation(context, cancellation.id)
}

/** Retry the money and access steps of a cancellation that did not finish. Settling twice moves nothing twice. */
export async function completeAgreementCancellation(input: unknown, orgId?: string) {
  const { cancellationId } = agreementCancellationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)
  await requirePermission("project.manage", context)
  const { data, error } = await context.supabase.from("purchase_agreement_cancellations").select("*")
    .eq("org_id", context.orgId).eq("id", cancellationId).maybeSingle()
  if (error) throw new Error(`Failed to load the cancellation: ${error.message}`)
  if (!data) throw new Error("Cancellation not found")
  const row = cancellationRowSchema.parse(data)
  await requireAuthorization({ permission: "sales.manage", userId: context.userId, orgId: context.orgId, projectId: row.project_id, supabase: context.supabase })
  if (row.settlement_status === "completed") return cancellationDto(row)
  if (row.deposit_disposition !== "none") await requirePermission("payment.release", context)
  return settleAgreementCancellation(context, row.id)
}

/** The latest cancellation of an agreement, for the deal's record of the sale. */
export async function getAgreementCancellation(contractId: string, orgId?: string): Promise<AgreementCancellation | null> {
  z.string().uuid().parse(contractId)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data, error } = await context.supabase.from("purchase_agreement_cancellations").select("*")
    .eq("org_id", context.orgId).eq("contract_id", contractId).maybeSingle()
  if (error) throw new Error(`Failed to load the cancellation: ${error.message}`)
  return data ? cancellationDto(cancellationRowSchema.parse(data)) : null
}

type DepositPayment = { paymentId: string; availableCents: number }

/**
 * Each received deposit payment and what is still the buyer's: received, less
 * what was refunded and less what was applied to another invoice. Refunding or
 * forfeiting the full received amount after a partial refund would move money
 * twice.
 */
async function availableDepositPayments(context: OrgServiceContext, depositInvoiceId: string): Promise<DepositPayment[]> {
  const { data: received, error } = await context.supabase.from("payments").select("id, amount_cents, metadata")
    .eq("org_id", context.orgId).eq("invoice_id", depositInvoiceId).in("status", ["succeeded", "completed"]).order("id")
  if (error) throw new Error(`Failed to load deposit payments: ${error.message}`)
  const collected = (received ?? []).filter((payment) => !(payment.metadata as Record<string, unknown> | null)?.customer_deposit_application)
  const ids = collected.map((payment) => String(payment.id))
  if (ids.length === 0) return []
  const [refunds, applications] = await Promise.all([
    context.supabase.from("payment_reversals").select("payment_id, amount_cents").eq("org_id", context.orgId).in("payment_id", ids).in("status", ["pending", "succeeded"]),
    context.supabase.from("payments").select("amount_cents, metadata, payment_reversals(amount_cents, status)").eq("org_id", context.orgId)
      .in("metadata->>deposit_payment_id", ids).in("status", ["succeeded", "completed", "paid"]),
  ])
  if (refunds.error || applications.error) throw new Error("Deposit refunds and applications could not be verified")
  const used = new Map<string, number>()
  for (const row of refunds.data ?? []) used.set(String(row.payment_id), (used.get(String(row.payment_id)) ?? 0) + Number(row.amount_cents))
  for (const row of applications.data ?? []) {
    const depositId = String((row.metadata as Record<string, unknown> | null)?.deposit_payment_id)
    const reversed = ((row.payment_reversals ?? []) as Array<{ amount_cents: number; status: string }>)
      .filter((reversal) => ["pending", "succeeded"].includes(reversal.status)).reduce((sum, reversal) => sum + Number(reversal.amount_cents), 0)
    used.set(depositId, (used.get(depositId) ?? 0) + Number(row.amount_cents) - reversed)
  }
  return collected.map((payment) => ({ paymentId: String(payment.id), availableCents: Math.max(Number(payment.amount_cents) - (used.get(String(payment.id)) ?? 0), 0) }))
}

/**
 * A forfeited deposit stops being the buyer's money and becomes the builder's
 * income: bill the forfeiture and apply the deposit to it, so the liability
 * clears and the revenue posts. Keyed by `source`, so a retry finds its own
 * invoice and applies only what is still owed to it.
 */
async function forfeitDeposit(context: OrgServiceContext, input: {
  source: Record<string, string>; projectId: string; buyerContactId: string | null; reason: string; amountCents: number; payments: DepositPayment[]
}) {
  if (input.amountCents <= 0) return { forfeitedCents: 0, invoiceId: null }
  const { data: existing, error } = await context.supabase.from("invoices").select("id").eq("org_id", context.orgId)
    .eq("project_id", input.projectId).contains("metadata", { invoice_kind: "deposit_forfeiture", ...input.source }).maybeSingle()
  if (error) throw new Error(`Failed to find the forfeiture invoice: ${error.message}`)
  const today = new Date().toISOString().slice(0, 10)
  const invoice = existing ?? await createInvoice({ input: {
    project_id: input.projectId, invoice_number: `FORFEIT-${Date.now().toString().slice(-9)}`, title: "Forfeited earnest deposit",
    // Issued (to no one) so it is open for the deposit to be applied against it.
    issue: true, issue_date: today, due_date: today, tax_rate: 0, customer_id: input.buyerContactId,
    lines: [{ description: `Forfeited earnest deposit — ${input.reason}`, quantity: 1, unit: "deposit", unit_cost: invoiceUnitCostFromCents(input.amountCents), taxable: false }],
    metadata: { invoice_kind: "deposit_forfeiture", ...input.source },
  }, orgId: context.orgId, context, authorizationPermission: "sales.manage", sendAuthorizationPermission: "sales.manage" })
  const { data: applied, error: appliedError } = await context.supabase.from("payments").select("amount_cents")
    .eq("org_id", context.orgId).eq("invoice_id", invoice.id).in("status", ["succeeded", "completed", "paid"])
  if (appliedError) throw new Error(`Failed to read the forfeiture's applications: ${appliedError.message}`)
  let owed = input.amountCents - (applied ?? []).reduce((sum, row) => sum + Number(row.amount_cents), 0)
  for (const payment of input.payments) {
    if (owed <= 0) break
    const amountCents = Math.min(owed, payment.availableCents)
    if (amountCents <= 0) continue
    await applyCustomerDepositWithContext(context, { depositPaymentId: payment.paymentId, targetInvoiceId: invoice.id, amountCents, appliedAt: new Date().toISOString() })
    owed -= amountCents
  }
  if (owed > 0) throw new Error("Less deposit is available than the forfeiture needs; review the deposit's refunds")
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "deposit_forfeited", entityType: "invoice", entityId: invoice.id, payload: { amount_cents: input.amountCents, ...input.source } })
  return { forfeitedCents: input.amountCents, invoiceId: invoice.id }
}

/** Refund up to `amountCents` across the payments that still hold the buyer's money. */
async function refundDeposit(context: OrgServiceContext, input: { amountCents: number; payments: DepositPayment[]; reason: string; metadata: Record<string, string> }) {
  let owed = input.amountCents
  for (const payment of input.payments) {
    if (owed <= 0) break
    const amountCents = Math.min(owed, payment.availableCents)
    if (amountCents <= 0) continue
    await recordPaymentReversal({ paymentId: payment.paymentId, amountCents, reversalType: "refund", reason: input.reason, metadata: input.metadata, orgId: context.orgId })
    owed -= amountCents
  }
  return input.amountCents - owed
}

const SETTLEMENT_LEASE_MS = 5 * 60_000

/**
 * The cancellation's money and access, claimed once (a stale claim can be
 * taken over) and recorded step by step on the receipt. What a step already did
 * is read back from the ledger, so a retry never refunds or forfeits twice.
 */
async function settleAgreementCancellation(context: OrgServiceContext, cancellationId: string): Promise<AgreementCancellation> {
  const service = createServiceSupabaseClient()
  const staleBefore = new Date(Date.now() - SETTLEMENT_LEASE_MS).toISOString()
  const { data: claimed, error: claimError } = await service.from("purchase_agreement_cancellations")
    .update({ settlement_status: "settling", settlement_claimed_at: new Date().toISOString() })
    .eq("org_id", context.orgId).eq("id", cancellationId)
    .or(`settlement_status.in.(pending,failed),and(settlement_status.eq.settling,settlement_claimed_at.lt.${staleBefore})`)
    .select("*").maybeSingle()
  if (claimError) throw new Error(`Failed to claim the cancellation's settlement: ${claimError.message}`)
  if (!claimed) {
    const { data: current } = await service.from("purchase_agreement_cancellations").select("*").eq("org_id", context.orgId).eq("id", cancellationId).maybeSingle()
    if (current?.settlement_status === "completed") return cancellationDto(cancellationRowSchema.parse(current))
    throw new Error("This cancellation is already being settled. Refresh in a moment.")
  }
  const row = cancellationRowSchema.parse(claimed)
  const outcomes: Record<string, unknown> = { ...row.outcomes }
  let step = "settling the deposit"
  try {
    const depositInvoiceId = row.plan.reservation?.deposit_invoice_id ?? null
    if (depositInvoiceId && row.deposit_disposition !== "none") {
      const { data: reservation, error } = await context.supabase.from("lot_reservations").select("buyer_contact_id").eq("org_id", context.orgId).eq("id", row.reservation_id ?? "").maybeSingle()
      if (error) throw new Error(error.message)
      const source = { source_agreement_cancellation_id: row.id }
      if (row.forfeit_cents > 0) {
        step = "forfeiting the deposit"
        outcomes.forfeiture = await forfeitDeposit(context, { source, projectId: row.project_id, buyerContactId: reservation?.buyer_contact_id ?? null, reason: row.reason,
          amountCents: row.forfeit_cents, payments: await availableDepositPayments(context, depositInvoiceId) })
        await projectJournal(context.orgId, { full: false })
      }
      if (row.refund_cents > 0) {
        step = "refunding the deposit"
        const { data: prior, error: priorError } = await context.supabase.from("payment_reversals").select("amount_cents")
          .eq("org_id", context.orgId).contains("metadata", { agreement_cancellation_id: row.id }).in("status", ["pending", "succeeded"])
        if (priorError) throw new Error(priorError.message)
        const alreadyRefunded = (prior ?? []).reduce((sum, reversal) => sum + Number(reversal.amount_cents), 0)
        const refunded = await refundDeposit(context, { amountCents: row.refund_cents - alreadyRefunded, payments: await availableDepositPayments(context, depositInvoiceId),
          reason: row.reason, metadata: { agreement_cancellation_id: row.id, ...(row.reservation_id ? { source_reservation_id: row.reservation_id } : {}) } })
        outcomes.refunded_cents = alreadyRefunded + refunded
      }
    }
    step = "ending the buyer's portal access"
    const { data: tokens, error: tokenError } = await context.supabase.from("portal_access_tokens").select("id").eq("org_id", context.orgId)
      .eq("project_id", row.project_id).eq("portal_type", "client").is("revoked_at", null)
    if (tokenError) throw new Error(tokenError.message)
    await Promise.all((tokens ?? []).map((token) => revokePortalToken(token.id, context.orgId)))
    outcomes.portal_tokens_revoked = Number(outcomes.portal_tokens_revoked ?? 0) + (tokens ?? []).length
    const { data: done, error: doneError } = await service.from("purchase_agreement_cancellations")
      .update({ settlement_status: "completed", completed_at: new Date().toISOString(), settlement_error: null, outcomes })
      .eq("org_id", context.orgId).eq("id", row.id).select("*").single()
    if (doneError || !done) throw new Error(doneError?.message ?? "The settlement could not be recorded")
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "purchase_agreement_cancellation_settled", entityType: "contract", entityId: row.contract_id, payload: { cancellation_id: row.id, outcomes } })
    return cancellationDto(cancellationRowSchema.parse(done))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure"
    await service.from("purchase_agreement_cancellations").update({ settlement_status: "failed", settlement_error: `${step}: ${message}`, outcomes })
      .eq("org_id", context.orgId).eq("id", row.id)
    throw new Error(`The sale was cancelled, but ${step} did not finish: ${message}. Retry it from the deal.`)
  }
}
import { createHash, randomUUID } from "crypto"
