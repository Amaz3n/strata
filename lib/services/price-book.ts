import { createHash } from "node:crypto"

import { resolvePriceForLinePure, type PriceAgreementCandidate, type PriceResolutionInput } from "@/lib/financials/price-resolution"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getPurchasingSettings } from "@/lib/services/purchasing-settings"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  priceAgreementFiltersSchema,
  priceAgreementInputSchema,
  repriceAgreementSchema,
  type PriceAgreementFilters,
  type PriceAgreementInput,
  type RepriceAgreementInput,
} from "@/lib/validation/price-book"

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
    .eq("org_id", orgId).order("effective_from", { ascending: false })
  const accessFilter = await agreementAccessFilter(supabase, orgId, userId)
  if (accessFilter) query = query.or(accessFilter)
  if (parsed.divisionId) query = query.or(await agreementDivisionFilter(supabase, orgId, parsed.divisionId))
  if (parsed.companyId) query = query.eq("company_id", parsed.companyId)
  if (parsed.costCodeId) query = query.eq("cost_code_id", parsed.costCodeId)
  if (parsed.communityId) query = query.eq("community_id", parsed.communityId)
  if (parsed.housePlanId) query = query.eq("house_plan_id", parsed.housePlanId)
  if (parsed.status) query = query.eq("status", parsed.status)
  if (parsed.expiringWithinDays) {
    const end = new Date(Date.now() + parsed.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)
    query = query.eq("status", "active").gte("effective_to", new Date().toISOString().slice(0, 10)).lte("effective_to", end)
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
    .order("effective_from", { ascending: true })
  if (accessFilter) historyQuery = historyQuery.or(accessFilter)
  const { data, error } = await historyQuery
  if (error) throw new Error(`Failed to load agreement history: ${error.message}`)
  return (data ?? []).filter((row) =>
    row.division_id === target.division_id && row.community_id === target.community_id
      && row.house_plan_id === target.house_plan_id && row.house_plan_version_id === target.house_plan_version_id,
  ).map((row) => mapAgreement(row))
}

export async function createPriceAgreement(input: PriceAgreementInput, orgId?: string) {
  const parsed = priceAgreementInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.write", orgId)
  const { data, error } = await supabase.from("vendor_price_agreements").insert({
    ...parsed, org_id: resolvedOrgId, created_by: userId,
  }).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to create price agreement: ${error?.message}`)
  const mapped = mapAgreement(data)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "price_agreement", entityId: mapped.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "price_agreement.created", entityType: "price_agreement", entityId: mapped.id })
  return mapped
}

export async function repriceAgreement(agreementId: string, input: RepriceAgreementInput, orgId?: string) {
  const parsed = repriceAgreementSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.write", orgId)
  const { data: old, error: oldError } = await supabase.from("vendor_price_agreements").select("*")
    .eq("org_id", resolvedOrgId).eq("id", agreementId).maybeSingle()
  if (oldError || !old) throw new Error("Price agreement not found")
  const service = createServiceSupabaseClient()
  const { data: newId, error } = await service.rpc("reprice_vendor_price_agreement", {
    p_org_id: resolvedOrgId, p_agreement_id: agreementId, p_effective_from: parsed.effective_from,
    p_unit_cost_cents: parsed.unit_cost_cents ?? null, p_lump_sum_cents: parsed.lump_sum_cents ?? null,
    p_notes: parsed.notes ?? null, p_actor_id: userId,
  })
  if (error || !newId) throw new Error(`Failed to reprice agreement: ${error?.message}`)
  const { data: created, error: reloadError } = await supabase.from("vendor_price_agreements").select(SELECT)
    .eq("org_id", resolvedOrgId).eq("id", newId).single()
  if (reloadError || !created) throw new Error("Repriced agreement could not be reloaded")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "price_agreement", entityId: agreementId, before: old, after: { superseded_by_id: newId } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "price_agreement", entityId: String(newId), after: created })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "price_agreement.repriced", entityType: "price_agreement", entityId: String(newId), payload: { superseded_id: agreementId } })
  return mapAgreement(created)
}

async function setAgreementState(agreementId: string, update: Record<string, unknown>, eventType: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.write", orgId)
  const { data: before, error: beforeError } = await supabase.from("vendor_price_agreements").select("*")
    .eq("org_id", resolvedOrgId).eq("id", agreementId).maybeSingle()
  if (beforeError || !before) throw new Error("Price agreement not found")
  const { data, error } = await supabase.from("vendor_price_agreements").update(update)
    .eq("org_id", resolvedOrgId).eq("id", agreementId).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to update agreement: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "price_agreement", entityId: agreementId, before, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType, entityType: "price_agreement", entityId: agreementId })
  return mapAgreement(data)
}

export function voidPriceAgreement(agreementId: string, orgId?: string) {
  return setAgreementState(agreementId, { status: "void" }, "price_agreement.voided", orgId)
}

export function setAgreementEnd(agreementId: string, effectiveTo: string, orgId?: string) {
  return setAgreementState(agreementId, { effective_to: effectiveTo }, "price_agreement.ended", orgId)
}

export async function getPriceBookHealth(filters: { divisionId?: string } = {}, orgId?: string) {
  const settings = await getPurchasingSettings(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.read", orgId)
  const today = new Date().toISOString().slice(0, 10)
  const expiring = new Date(Date.now() + settings.expiring_agreement_lead_days * 86_400_000).toISOString().slice(0, 10)
  const accessFilter = await agreementAccessFilter(supabase, resolvedOrgId, userId)
  const divisionFilter = filters.divisionId ? await agreementDivisionFilter(supabase, resolvedOrgId, filters.divisionId) : null
  let activeQuery = supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("status", "active")
  let expiringQuery = supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("status", "active").gte("effective_to", today).lte("effective_to", expiring)
  let rowsQuery = supabase.from("vendor_price_agreements").select("company_id,cost_code_id,division_id,community_id,house_plan_id,house_plan_version_id,effective_from").eq("org_id", resolvedOrgId).eq("status", "active").limit(5000)
  if (accessFilter) {
    activeQuery = activeQuery.or(accessFilter)
    expiringQuery = expiringQuery.or(accessFilter)
    rowsQuery = rowsQuery.or(accessFilter)
  }
  if (divisionFilter) {
    activeQuery = activeQuery.or(divisionFilter)
    expiringQuery = expiringQuery.or(divisionFilter)
    rowsQuery = rowsQuery.or(divisionFilter)
  }
  const [{ count: active }, { count: expiringCount }, { data: rows, error }] = await Promise.all([activeQuery, expiringQuery, rowsQuery])
  if (error) throw new Error(`Failed to load price-book health: ${error.message}`)
  const signatures = new Map<string, number>()
  for (const row of rows ?? []) {
    const key = [row.cost_code_id,row.division_id,row.community_id,row.house_plan_id,row.house_plan_version_id,row.effective_from].join("|")
    signatures.set(key, (signatures.get(key) ?? 0) + 1)
  }
  return { active: active ?? 0, expiring: expiringCount ?? 0, ambiguousOverlaps: Array.from(signatures.values()).filter((count) => count > 1).length, leadDays: settings.expiring_agreement_lead_days }
}

async function agreementAccessFilter(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  userId: string,
): Promise<string | null> {
  const access = await getDivisionAccessForUser({ orgId, userId })
  if (!access.assignedOnly) return null
  if (!access.divisionIds.length) return "id.eq.00000000-0000-0000-0000-000000000000"
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
  const { data, error } = await supabase.from("vendor_price_agreements").select("*")
    .eq("org_id", resolvedOrgId).eq("cost_code_id", input.costCodeId)
  if (error) throw new Error(`Failed to load price candidates: ${error.message}`)
  return resolvePriceForLinePure(input, data ?? [])
}

export async function importPriceAgreements({ rows, dryRun = true, orgId }: { rows: PriceAgreementInput[]; dryRun?: boolean; orgId?: string }) {
  const parsed = rows.map((row) => priceAgreementInputSchema.parse({ ...row, source: "import" }))
  const { supabase, orgId: resolvedOrgId, userId } = await authorize("price_book.write", orgId)
  const keyed = parsed.map((row) => ({ row, importKey: createHash("sha256").update(JSON.stringify(row)).digest("hex") }))
  const { data: existing, error } = await supabase.from("vendor_price_agreements").select("metadata")
    .eq("org_id", resolvedOrgId).eq("source", "import").limit(10_000)
  if (error) throw new Error(`Failed to check price-book imports: ${error.message}`)
  const existingKeys = new Set((existing ?? []).map((item) => item.metadata?.import_key).filter((key): key is string => typeof key === "string"))
  const pending = keyed.filter((item) => !existingKeys.has(item.importKey))
  if (!dryRun && pending.length > 0) {
    const { error: insertError } = await supabase.from("vendor_price_agreements").insert(pending.map(({ row, importKey }) => ({ ...row, org_id: resolvedOrgId, created_by: userId, metadata: { ...(row.metadata ?? {}), import_key: importKey } })))
    if (insertError) throw new Error(`Failed to import price agreements: ${insertError.message}`)
  }
  return { total: parsed.length, insertable: pending.length, skipped: parsed.length - pending.length, dryRun }
}
