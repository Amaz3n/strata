import type { PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getProspect, listProspectActivity, type Prospect, type ProspectActivity } from "@/lib/services/prospects"

/**
 * The seven stages of a production sale, in order. Observed from real state
 * (a deposit, a signature, a closing date) by get_sales_deals — never set by
 * hand, so a stage cannot go stale.
 */
export type SalesDealStage =
  | "lost"
  | "inquiry"
  | "working"
  | "hold"
  | "contract"
  | "building"
  | "closing"
  | "closed"

export interface SalesDeal {
  dealId: string
  prospectId: string | null
  reservationId: string | null
  contractId: string | null
  closingId: string | null
  projectId: string | null
  lotId: string | null
  communityId: string | null
  communityName: string | null
  divisionId: string | null
  lotLabel: string | null
  planName: string | null
  planBeds: number | null
  planBaths: number | null
  planSqft: number | null
  buyerName: string
  buyerPhone: string | null
  buyerEmail: string | null
  ownerUserId: string | null
  source: string | null
  stage: SalesDealStage
  stageRank: number
  priceCents: number | null
  holdExpiresAt: string | null
  nextFollowUpAt: string | null
  contractStatus: string | null
  contractSignedAt: string | null
  closingStatus: string | null
  closingScheduledDate: string | null
  closingActualDate: string | null
  openGateCount: number
  isOpen: boolean
  createdAt: string
  updatedAt: string | null
}

interface SalesDealRow {
  deal_id: string
  prospect_id: string | null
  reservation_id: string | null
  contract_id: string | null
  closing_id: string | null
  project_id: string | null
  lot_id: string | null
  community_id: string | null
  community_name: string | null
  division_id: string | null
  lot_label: string | null
  plan_name: string | null
  plan_beds: number | string | null
  plan_baths: number | string | null
  plan_sqft: number | null
  buyer_name: string
  buyer_phone: string | null
  buyer_email: string | null
  owner_user_id: string | null
  source: string | null
  stage: string
  stage_rank: number
  price_cents: number | string | null
  hold_expires_at: string | null
  next_follow_up_at: string | null
  contract_status: string | null
  contract_signed_at: string | null
  closing_status: string | null
  closing_scheduled_date: string | null
  closing_actual_date: string | null
  open_gate_count: number | string
  is_open: boolean
  created_at: string
  updated_at: string | null
}

const STAGES: SalesDealStage[] = ["lost", "inquiry", "working", "hold", "contract", "building", "closing", "closed"]

function toStage(value: string): SalesDealStage {
  const match = STAGES.find((stage) => stage === value)
  return match ?? "working"
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapDeal(row: SalesDealRow): SalesDeal {
  return {
    dealId: row.deal_id,
    prospectId: row.prospect_id,
    reservationId: row.reservation_id,
    contractId: row.contract_id,
    closingId: row.closing_id,
    projectId: row.project_id,
    lotId: row.lot_id,
    communityId: row.community_id,
    communityName: row.community_name,
    divisionId: row.division_id,
    lotLabel: row.lot_label,
    planName: row.plan_name,
    planBeds: toNumber(row.plan_beds),
    planBaths: toNumber(row.plan_baths),
    planSqft: row.plan_sqft,
    buyerName: row.buyer_name,
    buyerPhone: row.buyer_phone,
    buyerEmail: row.buyer_email,
    ownerUserId: row.owner_user_id,
    source: row.source,
    stage: toStage(row.stage),
    stageRank: row.stage_rank,
    priceCents: toNumber(row.price_cents),
    holdExpiresAt: row.hold_expires_at,
    nextFollowUpAt: row.next_follow_up_at,
    contractStatus: row.contract_status,
    contractSignedAt: row.contract_signed_at,
    closingStatus: row.closing_status,
    closingScheduledDate: row.closing_scheduled_date,
    closingActualDate: row.closing_actual_date,
    openGateCount: Number(row.open_gate_count ?? 0),
    isOpen: row.is_open,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ListSalesDealsOptions {
  divisionId?: string
  communityId?: string
  includeClosed?: boolean
  limit?: number
  dealId?: string
}

/**
 * Every deal the caller may see, one row per buyer. Division scoping mirrors
 * getBacklogReport: the RPC filters on the requested division, and an
 * assigned-only user is additionally filtered down to their own divisions.
 * Deals with no community (an unattributed lead) stay visible to everyone —
 * otherwise a brand-new inquiry would be invisible until someone tags it.
 */
export async function listSalesDeals(opts: ListSalesDealsOptions = {}, orgId?: string): Promise<SalesDeal[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const access = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (opts.divisionId && access.assignedOnly && !access.divisionIds.includes(opts.divisionId)) {
    return []
  }

  const { data, error } = await context.supabase.rpc("get_sales_deals", {
    p_org_id: context.orgId,
    p_division_id: opts.divisionId ?? null,
    p_community_id: opts.communityId ?? null,
    p_include_closed: opts.includeClosed ?? true,
    p_limit: opts.limit ?? 500,
    p_deal_id: opts.dealId ?? null,
  })
  if (error) throw new Error(`Failed to load sales deals: ${error.message}`)

  const rows = (data ?? []) as SalesDealRow[]
  const scoped = access.assignedOnly
    ? rows.filter((row) => !row.division_id || access.divisionIds.includes(row.division_id))
    : rows
  return scoped.map(mapDeal)
}

/**
 * A single deal by its synthetic id, for the deal detail page. Filtered inside
 * the RPC rather than scanned out of a full list, so the lookup keeps working
 * once a builder has more deals than the board's row cap.
 */
export async function getSalesDeal(dealId: string, orgId?: string): Promise<SalesDeal | null> {
  const deals = await listSalesDeals({ dealId, includeClosed: true, limit: 1 }, orgId)
  return deals[0] ?? null
}

export interface SalesDealReservation {
  id: string
  status: string
  expiresAt: string | null
  askingPriceCents: number | null
  depositRequiredCents: number
  depositInvoiceId: string | null
  notes: string | null
}

export interface SalesDealDetail {
  deal: SalesDeal
  reservation: SalesDealReservation | null
  /** Priced breakdown off the executed agreement snapshot, when there is one. */
  pricing: PurchaseAgreementPricing | null
  activity: ProspectActivity[]
  /**
   * The lead record behind the deal, when there is one. Carries what the board
   * row cannot: registration details, the lost reason, and the contacts the
   * consultant edits. Null for a deal anchored by an imported agreement.
   */
  prospect: Prospect | null
}

/**
 * Lost reasons for a set of deals, keyed by prospect id. Fetched only by the
 * Lost view rather than widening the board RPC, so the open board — the hot
 * path — pays nothing for it.
 */
export async function listLostReasons(prospectIds: string[], orgId?: string): Promise<Map<string, string>> {
  const reasons = new Map<string, string>()
  if (prospectIds.length === 0) return reasons
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data, error } = await context.supabase
    .from("prospects")
    .select("id, lost_reason")
    .eq("org_id", context.orgId)
    .in("id", prospectIds.slice(0, 500))
  if (error) throw new Error(`Failed to load lost reasons: ${error.message}`)
  for (const row of data ?? []) {
    if (row.lost_reason) reasons.set(row.id as string, row.lost_reason as string)
  }
  return reasons
}

/**
 * The buyer's whole file: the deal row plus the reservation terms, the agreement
 * price breakdown, and the event timeline. Everything the detail page renders.
 */
export async function getSalesDealDetail(dealId: string, orgId?: string): Promise<SalesDealDetail | null> {
  const deal = await getSalesDeal(dealId, orgId)
  if (!deal) return null

  const context = await requireOrgContext(orgId)
  const [reservationResult, contractResult, activity, prospect] = await Promise.all([
    deal.reservationId
      ? context.supabase
          .from("lot_reservations")
          .select("id, status, expires_at, asking_price_cents, deposit_required_cents, deposit_invoice_id, notes")
          .eq("org_id", context.orgId)
          .eq("id", deal.reservationId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    deal.contractId
      ? context.supabase
          .from("contracts")
          .select("snapshot")
          .eq("org_id", context.orgId)
          .eq("id", deal.contractId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    deal.prospectId ? listProspectActivity(deal.prospectId, context.orgId, 60) : Promise.resolve([]),
    deal.prospectId ? getProspect(deal.prospectId, context.orgId) : Promise.resolve(null),
  ])

  const reservationRow = reservationResult.data
  const snapshot = contractResult.data?.snapshot as
    | { purchase_agreement?: { pricing?: PurchaseAgreementPricing } }
    | null
    | undefined

  return {
    deal,
    reservation: reservationRow
      ? {
          id: String(reservationRow.id),
          status: String(reservationRow.status),
          expiresAt: reservationRow.expires_at ?? null,
          askingPriceCents: toNumber(reservationRow.asking_price_cents ?? null),
          depositRequiredCents: Number(reservationRow.deposit_required_cents ?? 0),
          depositInvoiceId: reservationRow.deposit_invoice_id ?? null,
          notes: reservationRow.notes ?? null,
        }
      : null,
    pricing: snapshot?.purchase_agreement?.pricing ?? null,
    activity,
    prospect,
  }
}
