import { createHash } from "node:crypto"

import { resolvePriceForLinePure, type PriceAgreementCandidate, type PriceResolutionInput } from "@/lib/financials/price-resolution"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getPurchasingSettings } from "@/lib/services/purchasing-settings"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  agreementEndSchema,
  agreementVoidSchema,
  priceAgreementFiltersSchema,
  priceAgreementInputSchema,
  renewalFiltersSchema,
  repriceAgreementSchema,
  type PriceAgreementFilters,
  type PriceAgreementInput,
  type RenewalFilters,
  type RepriceAgreementInput,
} from "@/lib/validation/price-book"
import { bestComparableBid, type PriceLine } from "@/lib/financials/renewal-compare"

export type PriceAgreement = PriceAgreementCandidate & {
  org_id: string
  company_name: string
  cost_code_code: string
  cost_code_name: string
  division_name?: string
  community_name?: string
  house_plan_name?: string
  source: "manual" | "bid_award" | "import"
  notes?: string | null
  superseded_by_id?: string | null
  created_at: string
}

function relatedName(value: unknown) {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== "object") return undefined
  const name = Reflect.get(relation, "name")
  return typeof name === "string" ? name : undefined
}

function mapAgreement(row: Record<string, unknown>): PriceAgreement {
  const companyName = relatedName(row.company)
  const costCodeRelation = Array.isArray(row.cost_code) ? row.cost_code[0] : row.cost_code
  const costCodeCode = costCodeRelation && typeof costCodeRelation === "object" ? Reflect.get(costCodeRelation, "code") : undefined
  const costCodeName = costCodeRelation && typeof costCodeRelation === "object" ? Reflect.get(costCodeRelation, "name") : undefined
  return {
    id: String(row.id), org_id: String(row.org_id), company_id: String(row.company_id),
    cost_code_id: String(row.cost_code_id), cost_type: typeof row.cost_type === "string" ? row.cost_type : null,
    division_id: typeof row.division_id === "string" ? row.division_id : null,
    community_id: typeof row.community_id === "string" ? row.community_id : null,
    house_plan_id: typeof row.house_plan_id === "string" ? row.house_plan_id : null,
    house_plan_version_id: typeof row.house_plan_version_id === "string" ? row.house_plan_version_id : null,
    pricing_kind: row.pricing_kind === "lump_sum" ? "lump_sum" : "unit",
    uom: typeof row.uom === "string" ? row.uom : null,
    unit_cost_cents: typeof row.unit_cost_cents === "number" ? row.unit_cost_cents : null,
    lump_sum_cents: typeof row.lump_sum_cents === "number" ? row.lump_sum_cents : null,
    scope_of_work: typeof row.scope_of_work === "string" ? row.scope_of_work : null,
    effective_from: String(row.effective_from),
    effective_to: typeof row.effective_to === "string" ? row.effective_to : null,
    status: String(row.status), company_name: companyName ?? "Unknown vendor",
    cost_code_code: typeof costCodeCode === "string" ? costCodeCode : "",
    cost_code_name: typeof costCodeName === "string" ? costCodeName : "Uncoded",
    division_name: relatedName(row.division), community_name: relatedName(row.community),
    house_plan_name: relatedName(row.house_plan),
    source: row.source === "bid_award" || row.source === "import" ? row.source : "manual",
    notes: typeof row.notes === "string" ? row.notes : null,
    superseded_by_id: typeof row.superseded_by_id === "string" ? row.superseded_by_id : null,
    created_at: String(row.created_at),
  }
}

const SELECT = `id, org_id, company_id, cost_code_id, cost_type, division_id, community_id,
  house_plan_id, house_plan_version_id, pricing_kind, uom, unit_cost_cents, lump_sum_cents,
  scope_of_work, effective_from, effective_to, status, superseded_by_id, source,
  source_bid_award_id, notes, metadata, created_at,
  company:companies(name), cost_code:cost_codes(code, name), division:divisions(name),
  community:communities(name), house_plan:house_plans(name)`

const CANDIDATE_SELECT = `id, company_id, cost_code_id, cost_type, division_id, community_id,
  house_plan_id, house_plan_version_id, pricing_kind, uom, unit_cost_cents, lump_sum_cents,
  scope_of_work, effective_from, effective_to, status`

/**
 * Only `active` and `expired` rows can change what `resolvePriceForLinePure`
 * returns: it prices from `active` rows and distinguishes "expired" from
 * "never priced" by looking for an `expired` scope match. Draft, superseded and
 * void rows are dead weight — and on a repriced book they are the overwhelming
 * majority, so excluding them is what keeps the candidate set bounded.
 */
const RESOLVABLE_STATUSES = ["active", "expired"] as const

export const PRICE_BOOK_PAGE_SIZE = 1000
/**
 * A single resolution pass reading more rows than this means the caller asked a
 * question nobody can answer correctly in one request. Fail loudly — silently
 * truncating the candidate set prices work at the wrong number.
 */
export const PRICE_BOOK_ROW_CAP = 20_000

const HISTORY_LIMIT = 200
const COVERAGE_GAP_DETAIL_LIMIT = 100
const IMPORT_KEY_LOOKUP_CHUNK = 200
const COST_CODE_LOOKUP_CHUNK = 200
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000"

type OrgSupabase = Awaited<ReturnType<typeof requireOrgContext>>["supabase"]

type PagedResponse<T> = { data: T[] | null; error: { message: string } | null }

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

/**
 * Reads every row a filter matches, one PostgREST page at a time. PostgREST caps
 * an unranged request at 1000 rows and reports no error when it truncates, so any
 * "load them all" query that money depends on has to walk the ranges itself.
 */
export async function collectPagedRows<T>({
  fetchPage,
  label,
  pageSize = PRICE_BOOK_PAGE_SIZE,
  cap = PRICE_BOOK_ROW_CAP,
}: {
  fetchPage: (from: number, to: number) => PromiseLike<PagedResponse<T>>
  label: string
  pageSize?: number
  cap?: number
}): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
    if (rows.length >= cap) {
      throw new Error(`Refusing to read more than ${cap} ${label} in one pass; narrow the scope before retrying.`)
    }
  }
}

/**
 * The candidate set every price resolution runs against. Paged to completion so a
 * full price book cannot silently drop the row that should have won.
 */
export async function loadPriceAgreementCandidates({
  supabase,
  orgId,
  costCodeIds,
}: {
  supabase: OrgSupabase
  orgId: string
  costCodeIds: string[]
}): Promise<PriceAgreementCandidate[]> {
  const uniqueCostCodeIds = Array.from(new Set(costCodeIds.filter(Boolean)))
  if (uniqueCostCodeIds.length === 0) return []
  return collectPagedRows<PriceAgreementCandidate>({
    label: "price agreements",
    fetchPage: (from, to) => supabase.from("vendor_price_agreements").select(CANDIDATE_SELECT)
      .eq("org_id", orgId).in("cost_code_id", uniqueCostCodeIds).in("status", RESOLVABLE_STATUSES)
      .order("id").range(from, to),
  })
}

async function authorize(permission: "price_book.read" | "price_book.write", orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: true })
  return context
}

export async function listPriceAgreements(filters: Partial<PriceAgreementFilters> = {}) {
  const parsed = priceAgreementFiltersSchema.parse(filters)
  const { supabase, orgId, userId } = await authorize("price_book.read")
  const from = (parsed.page - 1) * parsed.pageSize
  let query = supabase.from("vendor_price_agreements").select(SELECT, { count: "exact" })
    .eq("org_id", orgId).order("effective_from", { ascending: false }).order("id", { ascending: false })
  const accessFilter = await agreementAccessFilter(supabase, orgId, userId)
  if (accessFilter) query = query.or(accessFilter)
  if (parsed.agreementIds) query = query.in("id", parsed.agreementIds)
  if (parsed.divisionId) query = query.or(await agreementDivisionFilter(supabase, orgId, parsed.divisionId))
  if (parsed.companyId) query = query.eq("company_id", parsed.companyId)
  if (parsed.costCodeId) query = query.eq("cost_code_id", parsed.costCodeId)
  if (parsed.communityId) query = query.eq("community_id", parsed.communityId)
  if (parsed.housePlanId) query = query.eq("house_plan_id", parsed.housePlanId)
  if (parsed.status) query = query.eq("status", parsed.status)
  if (parsed.expiringWithinDays) {
    const end = new Date(Date.now() + parsed.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)
    query = query.eq("status", "active").is("superseded_by_id", null).gte("effective_to", new Date().toISOString().slice(0, 10)).lte("effective_to", end)
  }
  const { data, error, count } = await query.range(from, from + parsed.pageSize - 1)
  if (error) throw new Error(`Failed to list price agreements: ${error.message}`)
  return { items: (data ?? []).map((row) => mapAgreement(row)), count: count ?? 0, page: parsed.page, pageSize: parsed.pageSize }
}

export async function getPriceAgreementHistory(agreementId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.read", orgId)
  const accessFilter = await agreementAccessFilter(supabase, resolvedOrgId, userId)
  let targetQuery = supabase.from("vendor_price_agreements")
    .select("id, company_id, cost_code_id, division_id, community_id, house_plan_id, house_plan_version_id")
    .eq("org_id", resolvedOrgId).eq("id", agreementId)
  if (accessFilter) targetQuery = targetQuery.or(accessFilter)
  const { data: target, error: targetError } = await targetQuery.maybeSingle()
  if (targetError || !target) throw new Error("Price agreement not found")
  let historyQuery = supabase.from("vendor_price_agreements").select(SELECT)
    .eq("org_id", resolvedOrgId).eq("company_id", target.company_id).eq("cost_code_id", target.cost_code_id)
    .order("effective_from", { ascending: true }).limit(HISTORY_LIMIT)
  // The scope tuple identifies the price line whose history this is, so it is
  // filtered in the database rather than by pulling every agreement this vendor
  // holds for the cost code and discarding most of them in memory.
  const scopeColumns = [
    ["division_id", target.division_id],
    ["community_id", target.community_id],
    ["house_plan_id", target.house_plan_id],
    ["house_plan_version_id", target.house_plan_version_id],
  ] as const
  for (const [column, value] of scopeColumns) {
    historyQuery = value == null ? historyQuery.is(column, null) : historyQuery.eq(column, value)
  }
  if (accessFilter) historyQuery = historyQuery.or(accessFilter)
  const { data, error } = await historyQuery
  if (error) throw new Error(`Failed to load agreement history: ${error.message}`)
  return (data ?? []).map((row) => mapAgreement(row))
}

/**
 * The write-strict twin of `agreementAccessFilter`. A member limited to some
 * divisions may change a row only when its division, or its community's
 * division, is one of theirs; an org-wide row (no division, no community) is
 * everyone's to read and only an unrestricted member's to change. The database
 * policies say the same for direct writes; the state changes run as definer, so
 * the service says it first.
 */
export function agreementWriteAllowed(
  access: { assignedOnly: boolean; divisionIds: string[] },
  scope: { divisionId: string | null; communityId: string | null; communityDivisionId: string | null },
) {
  if (!access.assignedOnly) return true
  if (!scope.divisionId && !scope.communityId) return false
  if (scope.divisionId && !access.divisionIds.includes(scope.divisionId)) return false
  if (scope.communityId && !(scope.communityDivisionId && access.divisionIds.includes(scope.communityDivisionId))) return false
  return true
}

async function assertAgreementWriteAccess(
  context: { supabase: OrgSupabase; orgId: string; userId: string },
  scope: { division_id?: string | null; community_id?: string | null },
) {
  const access = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (!access.assignedOnly) return
  let communityDivisionId: string | null = null
  if (scope.community_id) {
    const { data, error } = await context.supabase.from("communities").select("division_id")
      .eq("org_id", context.orgId).eq("id", scope.community_id).maybeSingle()
    if (error) throw new Error(`Failed to check the community's division: ${error.message}`)
    communityDivisionId = data?.division_id ?? null
  }
  if (!agreementWriteAllowed(access, { divisionId: scope.division_id ?? null, communityId: scope.community_id ?? null, communityDivisionId })) {
    throw new Error("This price agreement is outside your divisions")
  }
}

async function countOrdersPricedFrom(orgId: string, agreementIds: string[]) {
  const { data, error } = await createServiceSupabaseClient().rpc("price_agreement_order_count", {
    p_org_id: orgId, p_agreement_ids: agreementIds,
  })
  if (error || typeof data !== "number") throw new Error(`Failed to count the orders priced from this agreement: ${error?.message}`)
  return data
}

/** What a void, end or reprice would touch, for the confirmation the buyer reads first. */
export async function getAgreementImpact(agreementId: string, orgId?: string) {
  const context = await authorize("price_book.write", orgId)
  const { data, error } = await context.supabase.from("vendor_price_agreements").select("id, division_id, community_id")
    .eq("org_id", context.orgId).eq("id", agreementId).maybeSingle()
  if (error || !data) throw new Error("Price agreement not found")
  await assertAgreementWriteAccess(context, data)
  return { affectedPoCount: await countOrdersPricedFrom(context.orgId, [agreementId]) }
}

export async function createPriceAgreement(input: PriceAgreementInput, orgId?: string) {
  const parsed = priceAgreementInputSchema.parse(input)
  const context = await authorize("price_book.write", orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await assertAgreementWriteAccess(context, parsed)
  const { data, error } = await supabase.from("vendor_price_agreements").insert({
    ...parsed, org_id: resolvedOrgId, created_by: userId,
  }).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to create price agreement: ${error?.message}`)
  const mapped = mapAgreement(data)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "price_agreement", entityId: mapped.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "price_agreement.created", entityType: "price_agreement", entityId: mapped.id })
  return mapped
}

async function loadAgreementForChange(context: { supabase: OrgSupabase; orgId: string; userId: string }, agreementId: string) {
  const { data, error } = await context.supabase.from("vendor_price_agreements").select("*")
    .eq("org_id", context.orgId).eq("id", agreementId).maybeSingle()
  if (error || !data) throw new Error("Price agreement not found")
  await assertAgreementWriteAccess(context, data)
  return data
}

export async function repriceAgreement(agreementId: string, input: RepriceAgreementInput, orgId?: string) {
  const parsed = repriceAgreementSchema.parse(input)
  const context = await authorize("price_book.write", orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  const old = await loadAgreementForChange(context, agreementId)
  const service = createServiceSupabaseClient()
  const { data: newId, error } = await service.rpc("reprice_vendor_price_agreement", {
    p_org_id: resolvedOrgId, p_agreement_id: agreementId, p_effective_from: parsed.effective_from,
    p_unit_cost_cents: parsed.unit_cost_cents ?? null, p_lump_sum_cents: parsed.lump_sum_cents ?? null,
    p_notes: parsed.notes ?? null, p_actor_id: userId, p_reason: parsed.reason,
  })
  if (error || !newId) throw new Error(`Failed to reprice agreement: ${error?.message}`)
  const [{ data: created, error: reloadError }, affectedPoCount] = await Promise.all([
    supabase.from("vendor_price_agreements").select(SELECT).eq("org_id", resolvedOrgId).eq("id", newId).single(),
    countOrdersPricedFrom(resolvedOrgId, [agreementId]),
  ])
  if (reloadError || !created) throw new Error("Repriced agreement could not be reloaded")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "price_agreement", entityId: agreementId, before: old, after: { superseded_by_id: newId, reason: parsed.reason } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "price_agreement", entityId: String(newId), after: created })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "price_agreement.repriced", entityType: "price_agreement", entityId: String(newId), payload: { superseded_id: agreementId, reason: parsed.reason } })
  return { agreement: mapAgreement(created), affectedPoCount }
}

async function changeAgreementState(
  agreementId: string,
  action: "void" | "end",
  change: { reason: string; effectiveTo: string | null },
  eventType: string,
  orgId?: string,
) {
  const context = await authorize("price_book.write", orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  const before = await loadAgreementForChange(context, agreementId)
  const { data: result, error } = await createServiceSupabaseClient().rpc("price_agreement_state", {
    p_org_id: resolvedOrgId, p_agreement_id: agreementId, p_action: action,
    p_effective_to: change.effectiveTo, p_reason: change.reason, p_actor_id: userId,
  })
  const affectedPoCount = result && typeof result === "object" && !Array.isArray(result) ? Reflect.get(result, "affected_po_count") : null
  if (error || typeof affectedPoCount !== "number") throw new Error(`Failed to ${action} the agreement: ${error?.message}`)
  const { data, error: reloadError } = await supabase.from("vendor_price_agreements").select(SELECT)
    .eq("org_id", resolvedOrgId).eq("id", agreementId).single()
  if (reloadError || !data) throw new Error("The agreement could not be reloaded")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "price_agreement", entityId: agreementId, before, after: { ...data, reason: change.reason } })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType, entityType: "price_agreement", entityId: agreementId, payload: { reason: change.reason, affected_po_count: affectedPoCount } })
  return { agreement: mapAgreement(data), affectedPoCount }
}

export function voidPriceAgreement(agreementId: string, input: { reason: string }, orgId?: string) {
  const parsed = agreementVoidSchema.parse(input)
  return changeAgreementState(agreementId, "void", { reason: parsed.reason, effectiveTo: null }, "price_agreement.voided", orgId)
}

export function setAgreementEnd(agreementId: string, input: { effective_to: string; reason: string }, orgId?: string) {
  const parsed = agreementEndSchema.parse(input)
  return changeAgreementState(agreementId, "end", { reason: parsed.reason, effectiveTo: parsed.effective_to }, "price_agreement.ended", orgId)
}

export type AgreementScope = {
  costCodeId: string
  costType: string | null
  divisionId: string | null
  communityId: string | null
  housePlanId: string | null
  housePlanVersionId: string | null
}

export type CoverageDemand = {
  communityId: string
  divisionId: string | null
  costCodeId: string
  plans: Array<{ housePlanId: string | null; housePlanVersionId: string | null }>
}

export type PriceBookCoverageGap = {
  communityId: string
  communityName: string
  costCodeId: string
  costCodeCode: string
  costCodeName: string
}

export type PriceBookHealth = {
  active: number
  expiring: number
  ambiguousOverlaps: number
  coverageGapCount: number
  coverageGaps: PriceBookCoverageGap[]
  leadDays: number
}

function groupCandidatesByCostCode(candidates: PriceAgreementCandidate[]) {
  const byCostCode = new Map<string, PriceAgreementCandidate[]>()
  for (const candidate of candidates) {
    const bucket = byCostCode.get(candidate.cost_code_id)
    if (bucket) bucket.push(candidate)
    else byCostCode.set(candidate.cost_code_id, [candidate])
  }
  return byCostCode
}

function scopeKey(scope: AgreementScope) {
  return [scope.costCodeId, scope.costType, scope.divisionId, scope.communityId, scope.housePlanId, scope.housePlanVersionId]
    .map((value) => value ?? "").join("|")
}

/**
 * Ambiguity reported here is the ambiguity the generator will actually raise:
 * every distinct scope present in the book is replayed through the same resolver
 * the PO run uses, so the desk count and the exception queue cannot disagree.
 * A pair that both lose to a more specific agreement is not an overlap.
 */
export function findAmbiguousAgreementScopes(candidates: PriceAgreementCandidate[], asOfDate: string) {
  const byCostCode = groupCandidatesByCostCode(candidates)
  const probed = new Set<string>()
  const byTiedSet = new Map<string, { scope: AgreementScope; agreementIds: string[] }>()
  for (const candidate of candidates) {
    const scope: AgreementScope = {
      costCodeId: candidate.cost_code_id,
      costType: candidate.cost_type ?? null,
      divisionId: candidate.division_id ?? null,
      communityId: candidate.community_id ?? null,
      housePlanId: candidate.house_plan_id ?? null,
      housePlanVersionId: candidate.house_plan_version_id ?? null,
    }
    const key = scopeKey(scope)
    if (probed.has(key)) continue
    probed.add(key)
    const result = resolvePriceForLinePure({
      costCodeId: scope.costCodeId, costType: scope.costType, uom: null, quantity: 1,
      housePlanId: scope.housePlanId, housePlanVersionId: scope.housePlanVersionId,
      communityId: scope.communityId, divisionId: scope.divisionId, asOfDate,
    }, byCostCode.get(scope.costCodeId) ?? [])
    if (result.resolved || result.exception.reason !== "ambiguous_agreement") continue
    const tiedKey = result.exception.candidates.join("|")
    if (!byTiedSet.has(tiedKey)) byTiedSet.set(tiedKey, { scope, agreementIds: result.exception.candidates })
  }
  return Array.from(byTiedSet.values())
}

/**
 * A cost code counts as covered for a community when at least one plan offered
 * there can be priced from it — a wrong unit or a tie is a pricing defect, not a
 * hole in the book, so only "nothing scope-compatible" and "everything lapsed"
 * are gaps.
 */
export function findCoverageGaps({ demands, candidatesByCostCode, asOfDate }: {
  demands: CoverageDemand[]
  candidatesByCostCode: Map<string, PriceAgreementCandidate[]>
  asOfDate: string
}) {
  const gaps: Array<{ communityId: string; costCodeId: string }> = []
  for (const demand of demands) {
    const candidates = candidatesByCostCode.get(demand.costCodeId) ?? []
    const covered = demand.plans.some((plan) => {
      const result = resolvePriceForLinePure({
        costCodeId: demand.costCodeId, costType: null, uom: null, quantity: 1,
        housePlanId: plan.housePlanId, housePlanVersionId: plan.housePlanVersionId,
        communityId: demand.communityId, divisionId: demand.divisionId, asOfDate,
      }, candidates)
      if (result.resolved) return true
      return result.exception.reason === "ambiguous_agreement" || result.exception.reason === "uom_mismatch"
    })
    if (!covered) gaps.push({ communityId: demand.communityId, costCodeId: demand.costCodeId })
  }
  return gaps
}

async function loadCoverageDemands(supabase: OrgSupabase, orgId: string, communities: Array<{ id: string; division_id: string | null }>) {
  const communityIds = communities.map((community) => community.id)
  if (communityIds.length === 0) return { demands: [], costCodeIds: [] as string[] }
  const availability = await collectPagedRows<{ community_id: string; house_plan_id: string }>({
    label: "community plan availability",
    fetchPage: (from, to) => supabase.from("community_plan_availability").select("community_id,house_plan_id")
      .eq("org_id", orgId).eq("is_available", true).in("community_id", communityIds).order("id").range(from, to),
  })
  const housePlanIds = Array.from(new Set(availability.map((row) => row.house_plan_id).filter(Boolean)))
  if (housePlanIds.length === 0) return { demands: [], costCodeIds: [] as string[] }

  const versions = await collectPagedRows<{ id: string; house_plan_id: string; version_number: number; released_at: string | null }>({
    label: "house plan versions",
    fetchPage: (from, to) => supabase.from("house_plan_versions").select("id,house_plan_id,version_number,released_at")
      .eq("org_id", orgId).in("house_plan_id", housePlanIds).order("id").range(from, to),
  })
  // A community is purchased against the plan version a start would pin: the
  // newest released one, falling back to the newest draft when nothing shipped.
  const currentVersionByPlan = new Map<string, { id: string; released: boolean; versionNumber: number }>()
  for (const version of versions) {
    const current = currentVersionByPlan.get(version.house_plan_id)
    const released = version.released_at != null
    const wins = !current
      || (released && !current.released)
      || (released === current.released && version.version_number > current.versionNumber)
    if (wins) currentVersionByPlan.set(version.house_plan_id, { id: version.id, released, versionNumber: version.version_number })
  }
  const versionIds = Array.from(currentVersionByPlan.values()).map((version) => version.id)
  if (versionIds.length === 0) return { demands: [], costCodeIds: [] as string[] }

  const takeoffLines = await collectPagedRows<{ house_plan_version_id: string; cost_code_id: string }>({
    label: "house plan takeoff lines",
    fetchPage: (from, to) => supabase.from("house_plan_takeoff_lines").select("house_plan_version_id,cost_code_id")
      .eq("org_id", orgId).in("house_plan_version_id", versionIds).order("id").range(from, to),
  })
  const costCodesByVersion = new Map<string, Set<string>>()
  for (const line of takeoffLines) {
    if (!line.cost_code_id) continue
    const bucket = costCodesByVersion.get(line.house_plan_version_id)
    if (bucket) bucket.add(line.cost_code_id)
    else costCodesByVersion.set(line.house_plan_version_id, new Set([line.cost_code_id]))
  }

  const divisionByCommunity = new Map(communities.map((community) => [community.id, community.division_id]))
  const plansByCommunity = new Map<string, Array<{ housePlanId: string; housePlanVersionId: string }>>()
  for (const row of availability) {
    const version = currentVersionByPlan.get(row.house_plan_id)
    if (!version) continue
    const bucket = plansByCommunity.get(row.community_id) ?? []
    if (!bucket.some((plan) => plan.housePlanVersionId === version.id)) {
      bucket.push({ housePlanId: row.house_plan_id, housePlanVersionId: version.id })
    }
    plansByCommunity.set(row.community_id, bucket)
  }

  const demands: CoverageDemand[] = []
  const costCodeIds = new Set<string>()
  for (const [communityId, plans] of plansByCommunity) {
    const byCostCode = new Map<string, Array<{ housePlanId: string; housePlanVersionId: string }>>()
    for (const plan of plans) {
      for (const costCodeId of costCodesByVersion.get(plan.housePlanVersionId) ?? []) {
        const bucket = byCostCode.get(costCodeId) ?? []
        bucket.push(plan)
        byCostCode.set(costCodeId, bucket)
      }
    }
    for (const [costCodeId, planRefs] of byCostCode) {
      costCodeIds.add(costCodeId)
      demands.push({ communityId, divisionId: divisionByCommunity.get(communityId) ?? null, costCodeId, plans: planRefs })
    }
  }
  return { demands, costCodeIds: Array.from(costCodeIds) }
}

export async function getPriceBookHealth(filters: { divisionId?: string } = {}, orgId?: string): Promise<PriceBookHealth> {
  const settings = await getPurchasingSettings(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.read", orgId)
  const today = new Date().toISOString().slice(0, 10)
  const expiring = new Date(Date.now() + settings.expiring_agreement_lead_days * 86_400_000).toISOString().slice(0, 10)
  const [accessFilter, access] = await Promise.all([
    agreementAccessFilter(supabase, resolvedOrgId, userId),
    getDivisionAccessForUser({ orgId: resolvedOrgId, userId }),
  ])
  const divisionFilter = filters.divisionId ? await agreementDivisionFilter(supabase, resolvedOrgId, filters.divisionId) : null
  let activeQuery = supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("status", "active")
  let expiringQuery = supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("status", "active").is("superseded_by_id", null).gte("effective_to", today).lte("effective_to", expiring)
  if (accessFilter) {
    activeQuery = activeQuery.or(accessFilter)
    expiringQuery = expiringQuery.or(accessFilter)
  }
  if (divisionFilter) {
    activeQuery = activeQuery.or(divisionFilter)
    expiringQuery = expiringQuery.or(divisionFilter)
  }
  // A requested division never widens access: a restricted user asking for a
  // division they are not assigned to gets nothing, not that division's book.
  const assignedDivisionIds = access.assignedOnly ? access.divisionIds : null
  const divisionIds = filters.divisionId
    ? (assignedDivisionIds && !assignedDivisionIds.includes(filters.divisionId) ? [] : [filters.divisionId])
    : assignedDivisionIds
  const [activeResult, expiringResult, activeAgreements, communities] = await Promise.all([
    activeQuery,
    expiringQuery,
    collectPagedRows<PriceAgreementCandidate>({
      label: "active price agreements",
      fetchPage: (from, to) => {
        let query = supabase.from("vendor_price_agreements").select(CANDIDATE_SELECT)
          .eq("org_id", resolvedOrgId).eq("status", "active")
        if (accessFilter) query = query.or(accessFilter)
        if (divisionFilter) query = query.or(divisionFilter)
        return query.order("id").range(from, to)
      },
    }),
    collectPagedRows<{ id: string; name: string; division_id: string | null }>({
      label: "communities",
      fetchPage: (from, to) => {
        let query = supabase.from("communities").select("id,name,division_id")
          .eq("org_id", resolvedOrgId).is("archived_at", null).in("status", ["planning", "active"])
        if (divisionIds) query = divisionIds.length ? query.in("division_id", divisionIds) : query.eq("id", EMPTY_UUID)
        return query.order("id").range(from, to)
      },
    }),
  ])
  if (activeResult.error) throw new Error(`Failed to count active price agreements: ${activeResult.error.message}`)
  if (expiringResult.error) throw new Error(`Failed to count expiring price agreements: ${expiringResult.error.message}`)

  const { demands, costCodeIds } = await loadCoverageDemands(supabase, resolvedOrgId, communities)
  // Coverage is asked of the whole book for the demanded cost codes, not just the
  // slice already loaded for ambiguity: an agreement that lapsed yesterday still
  // has to read as "expired", never as "never priced".
  const coverageCandidates = await loadPriceAgreementCandidates({ supabase, orgId: resolvedOrgId, costCodeIds })
  const gaps = findCoverageGaps({
    demands,
    candidatesByCostCode: groupCandidatesByCostCode(coverageCandidates),
    asOfDate: today,
  })
  const gapCostCodeIds = Array.from(new Set(gaps.map((gap) => gap.costCodeId)))
  const costCodeRows: Array<{ id: string; code: string; name: string }> = []
  for (const batch of chunk(gapCostCodeIds, COST_CODE_LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from("cost_codes").select("id,code,name").eq("org_id", resolvedOrgId).in("id", batch)
    if (error) throw new Error(`Failed to label price-book coverage gaps: ${error.message}`)
    costCodeRows.push(...(data ?? []))
  }
  const costCodeById = new Map(costCodeRows.map((row) => [row.id, row]))
  const communityById = new Map(communities.map((community) => [community.id, community.name]))

  return {
    active: activeResult.count ?? 0,
    expiring: expiringResult.count ?? 0,
    ambiguousOverlaps: findAmbiguousAgreementScopes(activeAgreements, today).length,
    coverageGapCount: gaps.length,
    coverageGaps: gaps.slice(0, COVERAGE_GAP_DETAIL_LIMIT).map((gap) => ({
      communityId: gap.communityId,
      communityName: communityById.get(gap.communityId) ?? "Community",
      costCodeId: gap.costCodeId,
      costCodeCode: costCodeById.get(gap.costCodeId)?.code ?? "",
      costCodeName: costCodeById.get(gap.costCodeId)?.name ?? "Uncoded",
    })),
    leadDays: settings.expiring_agreement_lead_days,
  }
}

async function agreementAccessFilter(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  userId: string,
): Promise<string | null> {
  const access = await getDivisionAccessForUser({ orgId, userId })
  if (!access.assignedOnly) return null
  if (!access.divisionIds.length) return `id.eq.${EMPTY_UUID}`
  const { data, error } = await supabase.from("communities").select("id").eq("org_id", orgId).in("division_id", access.divisionIds)
  if (error) throw new Error(`Failed to scope price agreements: ${error.message}`)
  const communityIds = (data ?? []).map((row) => row.id)
  const parts = [
    `division_id.in.(${access.divisionIds.join(",")})`,
    communityIds.length ? `community_id.in.(${communityIds.join(",")})` : null,
    "and(division_id.is.null,community_id.is.null)",
  ].filter(Boolean)
  return parts.join(",")
}

async function agreementDivisionFilter(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  divisionId: string,
): Promise<string> {
  const { data, error } = await supabase.from("communities").select("id").eq("org_id", orgId).eq("division_id", divisionId)
  if (error) throw new Error(`Failed to scope price agreements to division: ${error.message}`)
  const communityIds = (data ?? []).map((row) => row.id)
  const parts = [
    `division_id.eq.${divisionId}`,
    communityIds.length ? `community_id.in.(${communityIds.join(",")})` : null,
    "and(division_id.is.null,community_id.is.null)",
  ].filter(Boolean)
  return parts.join(",")
}

/** Shell-only posture check. Visibility is still permission-filtered by the nav. */
export async function orgHasPriceAgreements(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { count, error } = await supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId)
  if (error) throw new Error(`Failed to check purchasing navigation: ${error.message}`)
  return (count ?? 0) > 0
}

export async function resolvePriceForLine(input: PriceResolutionInput, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await authorize("price_book.read", orgId)
  const candidates = await loadPriceAgreementCandidates({ supabase, orgId: resolvedOrgId, costCodeIds: [input.costCodeId] })
  return resolvePriceForLinePure(input, candidates)
}

async function loadExistingImportKeys(supabase: OrgSupabase, orgId: string, importKeys: string[]) {
  const existing = new Set<string>()
  for (const batch of chunk(importKeys, IMPORT_KEY_LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from("vendor_price_agreements").select("metadata")
      .eq("org_id", orgId).eq("source", "import").in("metadata->>import_key", batch)
    if (error) throw new Error(`Failed to check price-book imports: ${error.message}`)
    for (const row of data ?? []) {
      const key = row.metadata?.import_key
      if (typeof key === "string") existing.add(key)
    }
  }
  return existing
}

export async function importPriceAgreements({ rows, dryRun = true, orgId }: { rows: PriceAgreementInput[]; dryRun?: boolean; orgId?: string }) {
  const parsed = rows.map((row) => priceAgreementInputSchema.parse({ ...row, source: "import" }))
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.write", orgId)
  const seenInBatch = new Set<string>()
  const keyed: Array<{ row: PriceAgreementInput; importKey: string }> = []
  for (const row of parsed) {
    const importKey = createHash("sha256").update(JSON.stringify(row)).digest("hex")
    if (seenInBatch.has(importKey)) continue
    seenInBatch.add(importKey)
    keyed.push({ row, importKey })
  }
  // Only the keys in this batch are looked up, so a large existing book neither
  // costs a 10k-row read nor silently stops deduplicating past the read cap.
  const existingKeys = await loadExistingImportKeys(supabase, resolvedOrgId, keyed.map((item) => item.importKey))
  const pending = keyed.filter((item) => !existingKeys.has(item.importKey))
  const toRow = ({ row, importKey }: { row: PriceAgreementInput; importKey: string }) => ({
    ...row, org_id: resolvedOrgId, created_by: userId,
    metadata: { ...(row.metadata ?? {}), import_key: importKey },
  })
  let inserted = pending
  if (!dryRun && pending.length > 0) {
    const { error: insertError } = await supabase.from("vendor_price_agreements").insert(pending.map(toRow))
    if (insertError && insertError.code !== "23505") throw new Error(`Failed to import price agreements: ${insertError.message}`)
    if (insertError) {
      // A concurrent import of the same file won the race for part of this batch.
      // The unique import key is the arbiter; re-read it and insert the remainder.
      const raced = await loadExistingImportKeys(supabase, resolvedOrgId, pending.map((item) => item.importKey))
      inserted = pending.filter((item) => !raced.has(item.importKey))
      if (inserted.length > 0) {
        const { error: retryError } = await supabase.from("vendor_price_agreements").insert(inserted.map(toRow))
        if (retryError) throw new Error(`Failed to import price agreements: ${retryError.message}`)
      }
    }
  }
  const insertable = dryRun ? pending.length : inserted.length
  return { total: parsed.length, insertable, skipped: parsed.length - insertable, dryRun }
}

export type RenewalBid = {
  packageId: string
  packageTitle: string
  companyId: string
  companyName: string
  submissionId: string
  price: PriceLine
  deltaCents: number | null
  deltaPct: number | null
}

export type RenewalRow = {
  agreement: PriceAgreement
  price: PriceLine
  bids: RenewalBid[]
  bestBidSubmissionId: string | null
  /** An open bid package already pricing this cost code in this scope; a second one would split the bids. */
  openPackage: { id: string; title: string } | null
}

const RENEWAL_PACKAGE_CAP = 300
const OPEN_BID_STATUSES = ["draft", "sent", "open", "closed"]

function agreementPrice(agreement: PriceAgreement): PriceLine {
  return agreement.pricing_kind === "unit"
    ? { kind: "unit", uom: agreement.uom ?? null, cents: agreement.unit_cost_cents ?? 0 }
    : { kind: "lump_sum", uom: null, cents: agreement.lump_sum_cents ?? 0 }
}

/**
 * Expiring agreements beside the replacement bids already on file for the same
 * community, plan and cost code. Read-only: awarding the replacement is the bid
 * package workbench's job. Bounded to one page of agreements, and the bid reads
 * are bounded by it.
 */
export async function getRenewalCandidates(filters: Partial<RenewalFilters> = {}, orgId?: string) {
  const parsed = renewalFiltersSchema.parse(filters)
  const expiring = await listPriceAgreements({ divisionId: parsed.divisionId, expiringWithinDays: parsed.windowDays, page: parsed.page, pageSize: parsed.pageSize })
  if (expiring.items.length === 0) return { rows: [] as RenewalRow[], count: expiring.count, page: expiring.page, pageSize: expiring.pageSize }
  const { supabase, orgId: resolvedOrgId } = await authorize("price_book.read", orgId)

  const costCodeIds = Array.from(new Set(expiring.items.map((agreement) => agreement.cost_code_id)))
  const communityIds = Array.from(new Set(expiring.items.flatMap((agreement) => agreement.community_id ? [agreement.community_id] : [])))
  const planIds = Array.from(new Set(expiring.items.flatMap((agreement) => agreement.house_plan_id ? [agreement.house_plan_id] : [])))
  const scopeFilters = [
    communityIds.length ? `community_id.in.(${communityIds.join(",")})` : null,
    planIds.length ? `house_plan_id.in.(${planIds.join(",")})` : null,
  ].filter((value): value is string => value !== null)
  const unbid = (openPackageOf: (agreement: PriceAgreement) => RenewalRow["openPackage"]) => ({
    rows: expiring.items.map((agreement): RenewalRow => ({ agreement, price: agreementPrice(agreement), bids: [], bestBidSubmissionId: null, openPackage: openPackageOf(agreement) })),
    count: expiring.count, page: expiring.page, pageSize: expiring.pageSize,
  })
  if (scopeFilters.length === 0) return unbid(() => null)

  const { data: packages, error: packageError } = await supabase.from("bid_packages").select("id, title, community_id, house_plan_id")
    .eq("org_id", resolvedOrgId).eq("award_target", "price_agreement").in("status", OPEN_BID_STATUSES)
    .or(scopeFilters.join(",")).order("created_at", { ascending: false }).limit(RENEWAL_PACKAGE_CAP)
  if (packageError) throw new Error(`Failed to load replacement bid packages: ${packageError.message}`)
  const packageIds = (packages ?? []).map((row) => row.id)
  if (packageIds.length === 0) return unbid(() => null)

  const [{ data: scopeItems, error: scopeError }, { data: invites, error: inviteError }] = await Promise.all([
    supabase.from("bid_scope_items").select("id, bid_package_id, cost_code_id, unit")
      .eq("org_id", resolvedOrgId).in("bid_package_id", packageIds).in("cost_code_id", costCodeIds),
    supabase.from("bid_invites").select("id, bid_package_id, company_id, company:companies!bid_invites_org_company_fk(name)")
      .eq("org_id", resolvedOrgId).in("bid_package_id", packageIds).eq("status", "submitted"),
  ])
  if (scopeError) throw new Error(`Failed to load replacement bid scope: ${scopeError.message}`)
  if (inviteError) throw new Error(`Failed to load replacement bidders: ${inviteError.message}`)
  const packageById = new Map((packages ?? []).map((row) => [row.id, row]))
  const openPackageOf = (agreement: PriceAgreement): RenewalRow["openPackage"] => {
    for (const scope of scopeItems ?? []) {
      const pkg = packageById.get(scope.bid_package_id)
      if (pkg && scope.cost_code_id === agreement.cost_code_id
        && (pkg.community_id ?? null) === (agreement.community_id ?? null) && (pkg.house_plan_id ?? null) === (agreement.house_plan_id ?? null)) {
        return { id: pkg.id, title: pkg.title }
      }
    }
    return null
  }
  if (!scopeItems?.length || !invites?.length) return unbid(openPackageOf)

  const { data: submissions, error: submissionError } = await supabase.from("bid_submissions").select("id, bid_invite_id")
    .eq("org_id", resolvedOrgId).eq("is_current", true).in("status", ["submitted", "revised"]).in("bid_invite_id", invites.map((row) => row.id))
  if (submissionError) throw new Error(`Failed to load replacement bids: ${submissionError.message}`)
  if (!submissions?.length) return unbid(openPackageOf)
  const { data: items, error: itemError } = await supabase.from("bid_submission_items")
    .select("bid_submission_id, bid_scope_item_id, amount_cents, unit_rate_cents, quantity")
    .eq("org_id", resolvedOrgId).eq("response", "priced").in("bid_submission_id", submissions.map((row) => row.id)).in("bid_scope_item_id", scopeItems.map((row) => row.id))
  if (itemError) throw new Error(`Failed to load replacement bid prices: ${itemError.message}`)

  const scopeById = new Map(scopeItems.map((row) => [row.id, row]))
  const inviteById = new Map(invites.map((row) => [row.id, row]))
  const submissionById = new Map(submissions.map((row) => [row.id, row]))

  const rows = expiring.items.map((agreement): RenewalRow => {
    const price = agreementPrice(agreement)
    const candidates: Array<{ price: PriceLine; bid: Omit<RenewalBid, "deltaCents" | "deltaPct"> }> = []
    for (const item of items ?? []) {
      const scope = scopeById.get(item.bid_scope_item_id)
      const submission = submissionById.get(item.bid_submission_id)
      const invite = submission ? inviteById.get(submission.bid_invite_id) : undefined
      const pkg = scope ? packageById.get(scope.bid_package_id) : undefined
      if (!scope || !submission || !invite || !pkg) continue
      if (scope.cost_code_id !== agreement.cost_code_id) continue
      if ((pkg.community_id ?? null) !== (agreement.community_id ?? null) || (pkg.house_plan_id ?? null) !== (agreement.house_plan_id ?? null)) continue
      if (item.amount_cents == null) continue
      const bidPrice: PriceLine = scope.unit == null
        ? { kind: "lump_sum", uom: null, cents: Number(item.amount_cents) }
        : { kind: "unit", uom: scope.unit, cents: Number(item.unit_rate_cents ?? Math.round(Number(item.amount_cents) / Math.max(Number(item.quantity ?? 1), 1))) }
      candidates.push({ price: bidPrice, bid: {
        packageId: pkg.id, packageTitle: pkg.title, companyId: invite.company_id, companyName: relatedName(invite.company) ?? "Unknown vendor",
        submissionId: submission.id, price: bidPrice,
      } })
    }
    const best = bestComparableBid(price, candidates)
    const bids = candidates.map(({ bid }) => {
      const comparison = bestComparableBid(price, [{ price: bid.price }])
      return { ...bid, deltaCents: comparison?.comparison.deltaCents ?? null, deltaPct: comparison?.comparison.deltaPct ?? null }
    })
    return { agreement, price, bids, bestBidSubmissionId: best ? best.bid.bid.submissionId : null, openPackage: openPackageOf(agreement) }
  })
  return { rows, count: expiring.count, page: expiring.page, pageSize: expiring.pageSize }
}
