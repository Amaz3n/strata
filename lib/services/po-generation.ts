import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { resolvePriceForLinePure, resolveSelectedAgreement, resolvedPriceTotal, type PriceAgreementCandidate } from "@/lib/financials/price-resolution"
import {
  createPoGenerationFingerprint,
  groupPurchaseOrderLines,
  type PoGenerationResolvedLine,
} from "@/lib/financials/po-generation-math"
import { recordAudit } from "@/lib/services/audit"
import {
  authorize,
  getDivisionAccessForUser,
  requireAuthorization,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { purchasingQueueFiltersSchema, purchasingQueueProjectSelect, resolvePurchasingQueueReadScope, type PurchasingQueueFilters } from "@/lib/services/purchasing-queue-scope"
import { recordEvent } from "@/lib/services/events"
import { collectPagedRows, loadPriceAgreementCandidates } from "@/lib/services/price-book"
import { getExpiringAgreementLeadDays } from "@/lib/services/purchasing-settings"
import { poExceptionResolutionSchema, poGenerationInputSchema, type PoExceptionResolution } from "@/lib/validation/po-generation"

type GenerationException = {
  cost_code_id: string | null
  source_kind: "takeoff_line" | "option"
  source_ref: Record<string, string>
  description: string
  quantity: number
  uom: string
  reason: "no_agreement" | "expired_agreement" | "ambiguous_agreement" | "uom_mismatch" | "no_vendor" | "no_cost_code"
  candidates: string[]
}

export type ExpiringAgreementWarning = {
  agreementId: string
  companyId: string
  companyName: string
  costCodeId: string
  description: string
  effectiveTo: string
  daysRemaining: number
}

/**
 * A generated line whose order has been sent, approved or billed. Generation
 * never rewrites it; when the vendor or amount would now differ purchasing
 * raises a variance order instead.
 */
export type PreservedPoChange = {
  sourceKey: string
  commitmentId: string
  contractNumber: string | null
  description: string
  wasCompanyName: string
  nowCompanyName: string
  wasCents: number
  nowCents: number
}

/** A line on an order in progress whose source (plan line or option) is no longer wanted. */
export type PreservedPoOrphan = {
  sourceKey: string
  commitmentId: string
  contractNumber: string | null
  description: string
  companyName: string
  cents: number
}

export type PoGenerationResult = {
  runId: string
  mode: "dry_run" | "commit"
  status: "succeeded" | "succeeded_with_exceptions" | "failed"
  inputFingerprint: string
  purchaseOrders: ReturnType<typeof groupPurchaseOrderLines>
  exceptions: GenerationException[]
  budgetLinesWritten: number
  /** Agreements this run priced from that lapse inside the org's lead window. */
  expiringAgreements: ExpiringAgreementWarning[]
  preservedChanged: PreservedPoChange[]
  preservedOrphaned: PreservedPoOrphan[]
}

/** The commit found the house changed since it was prepared; nothing was written. */
export class StalePoGenerationError extends Error {}

const commitResultSchema = z.object({
  run_id: z.string().uuid(),
  already_generated: z.boolean().optional(),
  refused: z.literal("exception_closed").optional(),
  budget_line_count: z.number().int().default(0),
  preserved_changed: z.array(z.object({
    source_key: z.string(), commitment_id: z.string().uuid(), contract_number: z.string().nullable(),
    description: z.string(), was_company_id: z.string().uuid().nullable(), now_company_id: z.string().uuid(),
    was_cents: z.number().int(), now_cents: z.number().int(),
  })).default([]),
  preserved_orphaned: z.array(z.object({
    source_key: z.string(), commitment_id: z.string().uuid(), contract_number: z.string().nullable(),
    description: z.string(), company_id: z.string().uuid().nullable(), cents: z.number().int(),
  })).default([]),
})

type ExceptionResolutionRun = {
  exceptionId: string
  sourceKey: string
  override: Record<string, unknown>
  status: "resolved_agreement" | "resolved_manual"
  stored: PoExceptionResolution
}

type GenerationContext = Awaited<ReturnType<typeof requireOrgContext>>

const poExceptionStatusSchema = z.enum(["open", "resolved_agreement", "resolved_manual", "dismissed"])

const poExceptionListSchema = purchasingQueueFiltersSchema.extend({
  status: poExceptionStatusSchema.default("open"),
})

const OPEN_EXCEPTION_SCAN_LIMIT = 1000
const PO_NUMBER_TOKEN_LENGTH = 12
const STALE_RETRY_LIMIT = 3

function relation<T extends Record<string, unknown>>(value: unknown): T | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as T : null
}

/** The identity of a priced thing across runs: which plan line or selection it came from. */
export function generationSourceKey(sourceKind: string, sourceId: string) {
  return `${sourceKind}:${sourceId}`
}

function poNumberToken(value: unknown, fallback: string) {
  const token = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return (token || fallback).slice(0, PO_NUMBER_TOKEN_LENGTH)
}

/**
 * Generated PO numbers carry the community, so Lot 42 in two communities cannot
 * collide. The commit appends the sequence under the project lock, continuing
 * past the highest number the house has ever been given.
 */
export function generatedPoNumberPrefix(
  scope: { communityCode?: unknown; communityName?: unknown; lotNumber?: unknown; block?: unknown },
) {
  const community = poNumberToken(scope.communityCode || scope.communityName, "COMM")
  const lot = poNumberToken(scope.lotNumber, "LOT")
  const blockToken = scope.block ? poNumberToken(scope.block, "") : ""
  const block = blockToken ? `-B${blockToken}` : ""
  return `PO-${community}-${lot}${block}`
}

function daysBetweenDates(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

/**
 * A start released against an agreement that lapses next week produces
 * `expired_agreement` exceptions days later, once trades are already scheduled.
 * Reporting it at generation time is the only moment purchasing can still act.
 */
export function findExpiringAgreements({ lines, agreementEndsById, asOfDate, leadDays }: {
  lines: Array<{ agreementId: string; companyId: string; companyName: string; costCodeId: string; description: string }>
  agreementEndsById: Map<string, string | null>
  asOfDate: string
  leadDays: number
}): ExpiringAgreementWarning[] {
  const warnings = new Map<string, ExpiringAgreementWarning>()
  for (const line of lines) {
    if (warnings.has(line.agreementId)) continue
    const effectiveTo = agreementEndsById.get(line.agreementId)
    if (!effectiveTo) continue
    const daysRemaining = daysBetweenDates(asOfDate, effectiveTo)
    if (daysRemaining < 0 || daysRemaining > leadDays) continue
    warnings.set(line.agreementId, {
      agreementId: line.agreementId, companyId: line.companyId, companyName: line.companyName,
      costCodeId: line.costCodeId, description: line.description, effectiveTo, daysRemaining,
    })
  }
  return Array.from(warnings.values()).sort((a, b) => a.daysRemaining - b.daysRemaining)
}

async function authorizeGeneration(permission: "po.generate" | "price_book.read" | "po_exception.resolve", projectId?: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission, userId: context.userId, orgId: context.orgId, projectId,
    supabase: context.supabase, logDecision: true, resourceType: projectId ? "project" : undefined, resourceId: projectId,
  })
  return context
}

/**
 * Generation reads go through the service client: purchasing works every house in its
 * divisions without being on each house team, so team RLS would hide the orders and
 * exceptions that numbering and de-duplication must see. Each caller authorizes first
 * (or right after loading) against the project, and every read is scoped by org_id.
 *
 * Loads the exception, then authorizes against the project it actually belongs to.
 * Authorizing without a project id would let a division-restricted user resolve —
 * and trigger generation on — work outside their divisions.
 */
async function authorizeExceptionAction(exceptionId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data: existing, error } = await createServiceSupabaseClient().from("po_generation_exceptions").select("*")
    .eq("org_id", context.orgId).eq("id", exceptionId).maybeSingle()
  if (error || !existing) throw new Error("PO exception not found")
  await requireAuthorization({
    permission: "po_exception.resolve", userId: context.userId, orgId: context.orgId,
    projectId: existing.project_id, supabase: context.supabase, logDecision: true,
    resourceType: "project", resourceId: existing.project_id,
  })
  return { ...context, existing }
}

async function loadOpenExceptionKeys(context: GenerationContext, projectId: string) {
  const { data, error } = await createServiceSupabaseClient().from("po_generation_exceptions").select("source_kind,source_ref")
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("status", "open").limit(OPEN_EXCEPTION_SCAN_LIMIT)
  if (error) throw new Error(`Failed to load open PO exceptions: ${error.message}`)
  const keys = new Set<string>()
  for (const row of data ?? []) {
    const sourceRef = row.source_ref as Record<string, unknown>
    const sourceId = row.source_kind === "takeoff_line" ? sourceRef.takeoff_line_id : sourceRef.project_selection_id
    if (typeof sourceId === "string") keys.add(generationSourceKey(row.source_kind, sourceId))
  }
  return keys
}

function exceptionSourceId(exception: GenerationException) {
  return exception.source_kind === "takeoff_line"
    ? exception.source_ref.takeoff_line_id
    : exception.source_ref.project_selection_id
}

async function runGeneration(
  parsed: { projectId: string; mode: "dry_run" | "commit"; asOfDate?: string; expectedFingerprint?: string },
  context: GenerationContext,
  options: { resolution?: ExceptionResolutionRun } = {},
): Promise<PoGenerationResult> {
  const { supabase, orgId, userId } = context
  await assertProjectConfiguration(orgId, parsed.projectId)
  const service = createServiceSupabaseClient()
  const resolution = options.resolution
  // A resolution being applied right now is not on the exception row yet: the
  // commit marks it resolved in the same transaction that creates its order.
  const pendingResolutions = resolution ? new Map([[resolution.sourceKey, resolution.override]]) : undefined
  const asOfDate = parsed.asOfDate ?? new Date().toISOString().slice(0, 10)

  const { data: lot, error: lotError } = await supabase.from("lots").select(`
    id, project_id, community_id, division_id, lot_number, block, house_plan_id,
    house_plan_version_id, house_plan_elevation_id,
    community:communities(name, code, division_id), house_plan:house_plans(name)
  `).eq("org_id", orgId).eq("project_id", parsed.projectId).maybeSingle()
  if (lotError || !lot?.house_plan_version_id || !lot.house_plan_id) {
    throw new Error("The project must be linked to a lot with a pinned house plan version before PO generation.")
  }

  // Every caller has authorized this project for the run. Selections are read
  // through the service client because their row-level security admits only
  // project members, so a preview by anyone else would silently drop every
  // option line that the release (always the service) then buys.
  const [{ data: takeoffs, error: takeoffError }, { data: selections, error: selectionError }] = await Promise.all([
    supabase.from("house_plan_takeoff_lines").select("id,cost_code_id,cost_type,description,quantity,uom,elevation_id")
      .eq("org_id", orgId).eq("house_plan_version_id", lot.house_plan_version_id).order("sort_order"),
    service.from("project_selections").select(`
      id, selected_option_id, cost_cents_snapshot, status,
      option:selection_options(id,name,sku,vendor,cost_cents,cost_code_id)
    `).eq("org_id", orgId).eq("project_id", parsed.projectId).eq("status", "confirmed"),
  ])
  if (takeoffError) throw new Error(`Failed to load plan takeoffs: ${takeoffError.message}`)
  if (selectionError && !selectionError.message.includes("project_selections")) {
    throw new Error(`Failed to load selected options: ${selectionError.message}`)
  }

  const selectedTakeoffs = (takeoffs ?? []).filter((line) => !line.elevation_id || line.elevation_id === lot.house_plan_elevation_id)
  const optionRows = selections ?? []
  const costCodeIds = Array.from(new Set([
    ...selectedTakeoffs.map((line) => line.cost_code_id),
    ...optionRows.flatMap((selection) => {
      const option = relation<Record<string, unknown>>(selection.option)
      return typeof option?.cost_code_id === "string" ? [option.cost_code_id] : []
    }),
  ]))
  const [candidates, { data: companies, error: companyError }, leadDays] = await Promise.all([
    loadPriceAgreementCandidates({ supabase, orgId, costCodeIds }),
    supabase.from("companies").select("id,name").eq("org_id", orgId).order("name").limit(10_000),
    getExpiringAgreementLeadDays(supabase, orgId),
  ])
  if (companyError) throw new Error(`Failed to load vendors: ${companyError.message}`)
  const companyNames = new Map((companies ?? []).map((company) => [String(company.id), String(company.name)]))
  const companyByNormalizedName = new Map((companies ?? []).map((company) => [String(company.name).trim().toLowerCase(), String(company.id)]))
  // Every manual price and chosen agreement the house has ever been given: a
  // cap here would silently turn older resolutions back into exceptions.
  const priorResolutions = await collectPagedRows<{ source_kind: string; source_ref: unknown; resolution: unknown }>({
    label: "PO exception resolutions",
    fetchPage: (from, to) => service.from("po_generation_exceptions")
      .select("source_kind,source_ref,resolution,resolved_at").eq("org_id", orgId).eq("project_id", parsed.projectId)
      .in("status", ["resolved_agreement", "resolved_manual"]).order("resolved_at", { ascending: false }).order("id").range(from, to),
  })
  const resolutionBySource = new Map<string, Record<string, unknown>>()
  for (const row of priorResolutions) {
    const sourceRef = row.source_ref as Record<string, unknown>
    const sourceId = row.source_kind === "takeoff_line" ? sourceRef.takeoff_line_id : sourceRef.project_selection_id
    const key = generationSourceKey(row.source_kind, String(sourceId ?? ""))
    if (!resolutionBySource.has(key) && row.resolution && typeof row.resolution === "object") resolutionBySource.set(key, row.resolution as Record<string, unknown>)
  }
  for (const [key, override] of pendingResolutions ?? []) resolutionBySource.set(key, override)
  const resolvedLines: PoGenerationResolvedLine[] = []
  const exceptions: GenerationException[] = []

  for (const line of selectedTakeoffs) {
    const input = {
      costCodeId: line.cost_code_id, costType: line.cost_type, uom: line.uom,
      quantity: Number(line.quantity), housePlanId: lot.house_plan_id,
      housePlanVersionId: lot.house_plan_version_id, communityId: lot.community_id,
      divisionId: lot.division_id ?? relation<Record<string, unknown>>(lot.community)?.division_id as string | null,
      asOfDate,
    }
    const override = resolutionBySource.get(generationSourceKey("takeoff_line", line.id))
    if (override?.kind === "manual" && typeof override.company_id === "string" && typeof override.unit_cost_cents === "number") {
      const totalCents = Math.round(Number(line.quantity) * override.unit_cost_cents)
      resolvedLines.push({ sourceKind: "takeoff_line", sourceId: line.id, companyId: override.company_id, companyName: companyNames.get(override.company_id) ?? "Unknown vendor", agreementId: `manual:${line.id}`, costCodeId: line.cost_code_id, costType: line.cost_type, description: line.description, quantity: Number(line.quantity), unit: line.uom, unitCostCents: override.unit_cost_cents, totalCents, scopeText: typeof override.note === "string" ? override.note : undefined })
      continue
    }
    const chosenAgreement = override?.kind === "agreement" && typeof override.agreement_id === "string"
      ? candidates.find((candidate) => candidate.id === override.agreement_id && candidate.cost_code_id === line.cost_code_id)
      : undefined
    const result = override?.kind === "agreement" && typeof override.agreement_id === "string" && pendingResolutions?.has(generationSourceKey("takeoff_line", line.id))
      ? resolveSelectedAgreement(input, candidates, override.agreement_id)
      : chosenAgreement
      ? { resolved: { agreementId: chosenAgreement.id, companyId: chosenAgreement.company_id, pricingKind: chosenAgreement.pricing_kind, unitCostCents: chosenAgreement.unit_cost_cents ?? undefined, lumpSumCents: chosenAgreement.lump_sum_cents ?? undefined, scopeOfWork: chosenAgreement.scope_of_work ?? undefined } }
      : resolvePriceForLinePure(input, candidates)
    if (result.exception) {
      exceptions.push({ cost_code_id: line.cost_code_id, source_kind: "takeoff_line", source_ref: { takeoff_line_id: line.id }, description: line.description, quantity: Number(line.quantity), uom: line.uom, reason: result.exception.reason, candidates: result.exception.candidates })
      continue
    }
    const totalCents = resolvedPriceTotal(input, result.resolved)
    resolvedLines.push({
      sourceKind: "takeoff_line", sourceId: line.id, companyId: result.resolved.companyId,
      companyName: companyNames.get(result.resolved.companyId) ?? "Unknown vendor",
      agreementId: result.resolved.agreementId, costCodeId: line.cost_code_id,
      costType: line.cost_type, description: line.description, quantity: result.resolved.pricingKind === "lump_sum" ? 1 : Number(line.quantity),
      unit: result.resolved.pricingKind === "lump_sum" ? "LS" : line.uom,
      unitCostCents: result.resolved.pricingKind === "lump_sum" ? totalCents : result.resolved.unitCostCents ?? 0,
      totalCents, scopeText: result.resolved.scopeOfWork,
    })
  }

  for (const selection of optionRows) {
    const option = relation<Record<string, unknown>>(selection.option)
    const sourceId = String(selection.id)
    const costCodeId = typeof option?.cost_code_id === "string" ? option.cost_code_id : null
    const optionName = typeof option?.name === "string" ? option.name : "Selected option"
    const sku = typeof option?.sku === "string" ? option.sku : null
    const descriptor = sku ? `${optionName} (${sku})` : optionName
    if (!costCodeId) {
      exceptions.push({ cost_code_id: null, source_kind: "option", source_ref: { project_selection_id: sourceId, option_id: String(option?.id ?? "") }, description: descriptor, quantity: 1, uom: "ea", reason: "no_cost_code", candidates: [] })
      continue
    }
    const costCents = typeof selection.cost_cents_snapshot === "number"
      ? selection.cost_cents_snapshot
      : typeof option?.cost_cents === "number" ? option.cost_cents : null
    const vendorHint = typeof option?.vendor === "string" ? option.vendor.trim().toLowerCase() : ""
    const hintedCompanyId = vendorHint ? companyByNormalizedName.get(vendorHint) : undefined
    const input = { costCodeId, costType: null, uom: "ea", quantity: 1, housePlanId: lot.house_plan_id, housePlanVersionId: lot.house_plan_version_id, communityId: lot.community_id, divisionId: lot.division_id, asOfDate }
    const override = resolutionBySource.get(generationSourceKey("option", sourceId))
    if (override?.kind === "manual" && typeof override.company_id === "string" && typeof override.unit_cost_cents === "number") {
      resolvedLines.push({ sourceKind: "option", sourceId, companyId: override.company_id, companyName: companyNames.get(override.company_id) ?? "Unknown vendor", agreementId: `manual:${sourceId}`, costCodeId, costType: null, description: descriptor, quantity: 1, unit: "ea", unitCostCents: override.unit_cost_cents, totalCents: override.unit_cost_cents, optionDescriptor: descriptor, scopeText: typeof override.note === "string" ? override.note : undefined })
      continue
    }
    const candidatePool = hintedCompanyId ? candidates.filter((candidate) => candidate.company_id === hintedCompanyId) : candidates
    const chosenAgreement = override?.kind === "agreement" && typeof override.agreement_id === "string"
      ? candidatePool.find((candidate) => candidate.id === override.agreement_id && candidate.cost_code_id === costCodeId)
      : undefined
    const priceResult = override?.kind === "agreement" && typeof override.agreement_id === "string" && pendingResolutions?.has(generationSourceKey("option", sourceId))
      ? resolveSelectedAgreement(input, candidatePool, override.agreement_id)
      : chosenAgreement
      ? { resolved: { agreementId: chosenAgreement.id, companyId: chosenAgreement.company_id, pricingKind: chosenAgreement.pricing_kind, unitCostCents: chosenAgreement.unit_cost_cents ?? undefined, lumpSumCents: chosenAgreement.lump_sum_cents ?? undefined, scopeOfWork: chosenAgreement.scope_of_work ?? undefined } }
      : resolvePriceForLinePure(input, candidatePool)
    const companyId = hintedCompanyId ?? priceResult?.resolved?.companyId
    if (!companyId) {
      const failure = priceResult?.exception
      exceptions.push({ cost_code_id: costCodeId, source_kind: "option", source_ref: { project_selection_id: sourceId, option_id: String(option?.id ?? "") }, description: descriptor, quantity: 1, uom: "ea", reason: vendorHint ? "no_vendor" : failure?.reason ?? "no_vendor", candidates: failure?.candidates ?? [] })
      continue
    }
    if (costCents == null && !priceResult?.resolved) {
      exceptions.push({ cost_code_id: costCodeId, source_kind: "option", source_ref: { project_selection_id: sourceId, option_id: String(option?.id ?? "") }, description: descriptor, quantity: 1, uom: "ea", reason: "no_agreement", candidates: [] })
      continue
    }
    const totalCents = costCents ?? resolvedPriceTotal(input, priceResult?.resolved ?? { agreementId: "", companyId, pricingKind: "unit", unitCostCents: 0 })
    resolvedLines.push({
      sourceKind: "option", sourceId, companyId, companyName: companyNames.get(companyId) ?? "Unknown vendor",
      agreementId: priceResult?.resolved?.agreementId ?? `option:${String(option?.id ?? sourceId)}`,
      costCodeId, costType: null, description: descriptor, quantity: 1, unit: "ea",
      unitCostCents: totalCents, totalCents, optionDescriptor: descriptor,
      scopeText: priceResult?.resolved?.scopeOfWork,
    })
  }

  // A pending resolution must actually produce its source line before any run,
  // budget, or PO is written. Removed selections and unpriceable lines remain open.
  const resolvedSourceKeys = new Set(resolvedLines.map((line) => generationSourceKey(line.sourceKind, line.sourceId)))
  for (const key of pendingResolutions?.keys() ?? []) {
    if (!resolvedSourceKeys.has(key)) throw new Error("This exception could not be priced, or its source is no longer active. Refresh the queue before resolving it.")
  }

  const purchaseOrders = groupPurchaseOrderLines(resolvedLines)
  const agreementEndsById = new Map<string, string | null>(
    candidates.map((candidate: PriceAgreementCandidate) => [candidate.id, candidate.effective_to ?? null]),
  )
  const expiringAgreements = findExpiringAgreements({ lines: resolvedLines, agreementEndsById, asOfDate, leadDays })
  const inputFingerprint = createPoGenerationFingerprint({
    asOfDate,
    lines: [
      ...resolvedLines.map((line) => ({ sourceKind: line.sourceKind, sourceId: line.sourceId, companyId: line.companyId, quantity: line.quantity, unit: line.unit, agreementId: line.agreementId, totalCents: line.totalCents })),
      ...exceptions.map((item) => ({ sourceKind: item.source_kind, sourceId: Object.values(item.source_ref)[0] ?? item.description, quantity: item.quantity, unit: item.uom, agreementId: null, totalCents: null })),
    ],
  })

  if (parsed.mode === "commit" && parsed.expectedFingerprint && parsed.expectedFingerprint !== inputFingerprint) {
    throw new Error("Pricing or selections changed since the preview. Preview the purchase orders again before generating.")
  }

  // Runs are read as the commit reads them (every run of the house, whoever
  // started it), not through the caller's row security.
  const { data: prior, error: priorError } = await service.from("po_generation_runs").select("id,input_fingerprint,status")
    .eq("org_id", orgId).eq("project_id", parsed.projectId).eq("mode", "commit")
    .in("status", ["succeeded", "succeeded_with_exceptions"]).order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(1).maybeSingle()
  if (priorError) throw new Error(`Failed to read the last PO generation run: ${priorError.message}`)
  const vendorName = (companyId: string | null) => (companyId ? companyNames.get(companyId) : undefined) ?? "Unknown vendor"
  if (parsed.mode === "commit" && !resolution && prior?.input_fingerprint === inputFingerprint) {
    return { runId: prior.id, mode: "commit", status: prior.status, inputFingerprint, purchaseOrders, exceptions, budgetLinesWritten: 0, expiringAgreements, preservedChanged: [], preservedOrphaned: [] }
  }

  const openExceptionKeys = await loadOpenExceptionKeys(context, parsed.projectId)
  // An exception already sitting open for the same source line is the same
  // exception; re-inserting it every run buries the queue in duplicates.
  const newExceptions = exceptions.filter((item) => {
    const sourceId = exceptionSourceId(item)
    return !sourceId || !openExceptionKeys.has(generationSourceKey(item.source_kind, sourceId))
  })

  const summary = {
    po_count: purchaseOrders.length, line_count: resolvedLines.length,
    total_cents: resolvedLines.reduce((sum, line) => sum + line.totalCents, 0),
    exception_count: exceptions.length,
    per_vendor: purchaseOrders.map((po) => ({ company_id: po.companyId, company_name: po.companyName, total_cents: po.totalCents, line_count: po.lines.length })),
  }
  // The run, its exceptions and every commit are written by the service after
  // the caller was authorized: members hold read access to these tables only.
  const { data: run, error: runError } = await service.from("po_generation_runs").insert({
    org_id: orgId, project_id: parsed.projectId, lot_id: lot.id,
    house_plan_version_id: lot.house_plan_version_id, mode: parsed.mode, status: "running",
    as_of_date: asOfDate, input_fingerprint: inputFingerprint, summary, created_by: userId,
  }).select("id").single()
  if (runError || !run) throw new Error(`Failed to create PO generation run: ${runError?.message}`)

  let committedRaw: unknown = null
  try {
    if (parsed.mode === "dry_run") {
      if (newExceptions.length > 0) {
        const { error: exceptionError } = await service.from("po_generation_exceptions").insert(newExceptions.map((item) => ({ ...item, org_id: orgId, run_id: run.id, project_id: parsed.projectId })))
        if (exceptionError) throw new Error(`Failed to record PO exceptions: ${exceptionError.message}`)
      }
      const status = exceptions.length ? "succeeded_with_exceptions" : "succeeded"
      const { error: finishError } = await service.from("po_generation_runs").update({ status, completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", run.id)
      if (finishError) throw new Error(`Failed to finish the PO preview: ${finishError.message}`)
    } else {
      const community = relation<Record<string, unknown>>(lot.community)
      const plan = relation<Record<string, unknown>>(lot.house_plan)
      const payload = {
        // The commit refuses a whole-house payload whose prior run is no longer
        // the latest (a competing commit or resolution landed first).
        prior_run_id: resolution ? null : prior?.id ?? null,
        // A resolution touches only its own source line; a whole-house commit reconciles them all.
        scope_source_keys: resolution ? [resolution.sourceKey] : null,
        po_number_prefix: generatedPoNumberPrefix({ communityCode: community?.code, communityName: community?.name, lotNumber: lot.lot_number, block: lot.block }),
        lot_label: `${community?.name ?? "Community"} Lot ${lot.lot_number}${lot.block ? ` Block ${lot.block}` : ""}`,
        plan_name: typeof plan?.name === "string" ? plan.name : null,
        summary: { ...summary, scoped: Boolean(resolution) },
        lines: resolvedLines.map((line) => ({
          source_kind: line.sourceKind, source_id: line.sourceId, company_id: line.companyId,
          cost_code_id: line.costCodeId, cost_type: line.costType ?? null, description: line.description,
          quantity: line.quantity, unit: line.unit, unit_cost_cents: line.unitCostCents, total_cents: line.totalCents,
          agreement_id: line.agreementId, scope_text: line.scopeText ?? null, option_descriptor: line.optionDescriptor ?? null,
        })),
        exceptions: resolution ? [] : newExceptions,
        resolve_exception: resolution
          ? { id: resolution.exceptionId, status: resolution.status, resolution: resolution.stored, resolved_by: userId }
          : null,
      }
      const { data, error: commitError } = await service.rpc("run_po_generation_commit", { p_org_id: orgId, p_run_id: run.id, p_payload: payload })
      if (commitError) {
        if (commitError.code === "40001") throw new StalePoGenerationError(commitError.message)
        throw new Error(commitError.message)
      }
      committedRaw = data
    }
  } catch (error) {
    await service.from("po_generation_runs").update({ status: "failed", error: error instanceof Error ? error.message : String(error), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", run.id)
    throw error
  }

  const status = exceptions.length ? "succeeded_with_exceptions" : "succeeded"
  const committed = parsed.mode === "commit" ? commitResultSchema.parse(committedRaw) : null
  if (committed?.refused) throw new Error("This PO exception has already been resolved or dismissed.")
  const preservedChanged = (committed?.preserved_changed ?? []).map((item) => ({
    sourceKey: item.source_key, commitmentId: item.commitment_id, contractNumber: item.contract_number, description: item.description,
    wasCompanyName: vendorName(item.was_company_id), nowCompanyName: vendorName(item.now_company_id), wasCents: item.was_cents, nowCents: item.now_cents,
  }))
  const preservedOrphaned = (committed?.preserved_orphaned ?? []).map((item) => ({
    sourceKey: item.source_key, commitmentId: item.commitment_id, contractNumber: item.contract_number,
    description: item.description, companyName: vendorName(item.company_id), cents: item.cents,
  }))
  // An identical commit that lost the race: the winner's run is the answer, and it already wrote the trail.
  if (committed?.already_generated) {
    return { runId: committed.run_id, mode: "commit", status, inputFingerprint, purchaseOrders, exceptions, budgetLinesWritten: 0, expiringAgreements, preservedChanged, preservedOrphaned }
  }
  await recordAudit({ orgId, actorId: userId, action: "insert", entityType: "po_generation_run", entityId: run.id, after: { ...summary, mode: parsed.mode, status, scoped: Boolean(resolution), preserved_changed: preservedChanged.length, preserved_orphaned: preservedOrphaned.length } })
  await recordEvent({ orgId, actorId: userId, eventType: "po_generation.completed", entityType: "po_generation_run", entityId: run.id, payload: { project_id: parsed.projectId, mode: parsed.mode, scoped: Boolean(resolution), preserved_changed: preservedChanged.length, ...summary } })
  return {
    runId: run.id, mode: parsed.mode, status, inputFingerprint, purchaseOrders, exceptions,
    budgetLinesWritten: committed?.budget_line_count ?? 0, expiringAgreements, preservedChanged, preservedOrphaned,
  }
}

export async function generatePurchaseOrders(args: { projectId: string; mode: "dry_run" | "commit"; asOfDate?: string; expectedFingerprint?: string; orgId?: string }): Promise<PoGenerationResult> {
  const parsed = poGenerationInputSchema.parse(args)
  const context = await authorizeGeneration("po.generate", parsed.projectId, args.orgId)
  return runGeneration(parsed, context)
}

/**
 * System commit for the automatic starts release. It has no preview to match, so it
 * computes its own fingerprint inside the run and is never reachable from a client.
 */
export async function generatePurchaseOrdersForStartsRelease(args: { projectId: string; orgId: string }): Promise<PoGenerationResult> {
  const projectId = z.string().uuid().parse(args.projectId)
  const context = await authorizeGeneration("po.generate", projectId, args.orgId)
  // A buyer's resolution can land between this run reading the house and
  // committing it. The commit refuses and writes nothing; reading the house
  // again picks the resolution up, so the release goes on instead of failing.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runGeneration({ projectId, mode: "commit" }, context)
    } catch (error) {
      if (!(error instanceof StalePoGenerationError) || attempt >= STALE_RETRY_LIMIT) throw error
    }
  }
}

export type ProjectPoGenerationSummary = {
  lastRunStatus: string | null
  lastRunAt: string | null
  openExceptions: number
}

/**
 * What the project's generation panel shows, or null when the project cannot
 * have purchase orders generated: no lot with a pinned plan version, or a
 * caller who may not generate.
 */
export async function getProjectPoGenerationSummary(projectId: string, orgId?: string): Promise<ProjectPoGenerationSummary | null> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  const decision = await authorize({ permission: "po.generate", userId, orgId: resolvedOrgId, projectId, supabase })
  if (!decision.allowed) return null
  const [lot, lastRun, open] = await Promise.all([
    supabase.from("lots").select("id").eq("org_id", resolvedOrgId).eq("project_id", projectId).not("house_plan_version_id", "is", null).maybeSingle(),
    supabase.from("po_generation_runs").select("status,completed_at").eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("mode", "commit")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("po_generation_exceptions").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("status", "open"),
  ])
  if (lot.error) throw new Error(`Failed to check PO generation for the project: ${lot.error.message}`)
  if (lastRun.error) throw new Error(`Failed to read the last PO generation run: ${lastRun.error.message}`)
  if (open.error) throw new Error(`Failed to count PO exceptions: ${open.error.message}`)
  if (!lot.data) return null
  return { lastRunStatus: lastRun.data?.status ?? null, lastRunAt: lastRun.data?.completed_at ?? null, openExceptions: open.count ?? 0 }
}

export type PoExceptionQueueRow = {
  id: string
  project_id: string
  description: string
  reason: string
  quantity: number | string | null
  uom: string | null
  candidates: unknown
  created_at: string
  project: unknown
  cost_code: unknown
}

export async function listPoExceptions(filters: PurchasingQueueFilters & { status?: string; orgId?: string } = {}) {
  const parsed = poExceptionListSchema.parse(filters)
  const context = await authorizeGeneration("price_book.read", parsed.projectId, filters.orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  if (scope.divisionIds?.length === 0) return { items: [], count: 0, page: parsed.page, pageSize: parsed.pageSize }
  const columns: string = `*, ${purchasingQueueProjectSelect("name", scope, parsed.communityId)}, cost_code:cost_codes(code,name)`
  let query = supabase.from("po_generation_exceptions").select(columns, { count: "exact" })
    .eq("org_id", resolvedOrgId).eq("project.org_id", resolvedOrgId).eq("status", parsed.status).order("created_at").order("id")
  if (parsed.projectId) query = query.eq("project_id", parsed.projectId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (parsed.communityId) query = query.eq("project.lot.community_id", parsed.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  const { data, error, count } = await query.range((parsed.page - 1) * parsed.pageSize, parsed.page * parsed.pageSize - 1).returns<PoExceptionQueueRow[]>()
  if (error) throw new Error(`Failed to list PO exceptions: ${error.message}`)
  return { items: data ?? [], count: count ?? 0, page: parsed.page, pageSize: parsed.pageSize }
}

export async function resolvePoException(exceptionId: string, resolution: PoExceptionResolution, orgId?: string) {
  const parsed = poExceptionResolutionSchema.parse(resolution)
  const context = await authorizeExceptionAction(exceptionId, orgId)
  const { supabase, orgId: resolvedOrgId, userId, existing } = context
  if (existing.status !== "open") throw new Error("This PO exception has already been resolved or dismissed.")
  if (parsed.kind === "manual") {
    const { data: vendor, error: vendorError } = await supabase.from("companies").select("id")
      .eq("org_id", resolvedOrgId).eq("id", parsed.company_id).maybeSingle()
    if (vendorError) throw new Error(`Failed to validate the selected vendor: ${vendorError.message}`)
    if (!vendor) throw new Error("The selected vendor is not available in this organization.")
  }
  const sourceRef = existing.source_ref as Record<string, unknown>
  const sourceId = existing.source_kind === "takeoff_line" ? sourceRef.takeoff_line_id : sourceRef.project_selection_id
  if (typeof sourceId !== "string") throw new Error("This PO exception has no source line to price.")
  const pending: Record<string, unknown> = parsed.kind === "agreement"
    ? { kind: "agreement", agreement_id: parsed.agreement_id }
    : { kind: "manual", company_id: parsed.company_id, unit_cost_cents: parsed.unit_cost_cents, note: parsed.note ?? null }

  // One transaction creates the order and marks the exception resolved, so a
  // crash cannot leave an order behind an open exception, and two people
  // resolving the same line at once yield one order and one refusal.
  const status = parsed.kind === "agreement" ? "resolved_agreement" : "resolved_manual"
  const regeneration = await runGeneration(
    { projectId: existing.project_id, mode: "commit" },
    context,
    { resolution: { exceptionId, sourceKey: generationSourceKey(existing.source_kind, sourceId), override: pending, status, stored: parsed } },
  )
  const { data, error } = await createServiceSupabaseClient().from("po_generation_exceptions").select("*")
    .eq("org_id", resolvedOrgId).eq("id", exceptionId).single()
  if (error || !data) throw new Error(`Failed to read the resolved PO exception: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_generation_exception", entityId: exceptionId, before: existing, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_exception.resolved", entityType: "po_generation_exception", entityId: exceptionId, payload: { project_id: existing.project_id, run_id: regeneration.runId } })
  return { ...data, regeneration }
}

export async function dismissPoException(exceptionId: string, note: string, orgId?: string) {
  const { orgId: resolvedOrgId, userId, existing } = await authorizeExceptionAction(exceptionId, orgId)
  if (existing.status !== "open") throw new Error("This PO exception has already been resolved or dismissed.")
  // Conditional on still being open: a resolution that lands first keeps its
  // purchase order and its resolution record instead of being relabelled.
  const { data, error } = await createServiceSupabaseClient().from("po_generation_exceptions").update({
    status: "dismissed",
    resolution: { note: note.trim() || "Dismissed by purchasing" },
    resolved_by: userId,
    resolved_at: new Date().toISOString(),
  }).eq("org_id", resolvedOrgId).eq("id", exceptionId).eq("status", "open").select("*").maybeSingle()
  if (error) throw new Error(`Failed to dismiss PO exception: ${error.message}`)
  if (!data) throw new Error("This PO exception has already been resolved or dismissed.")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_generation_exception", entityId: exceptionId, before: existing, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_exception.dismissed", entityType: "po_generation_exception", entityId: exceptionId, payload: { project_id: existing.project_id } })
  return data
}

export async function hasOpenPoExceptions(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await authorizeGeneration("price_book.read", projectId, orgId)
  const { count, error } = await supabase.from("po_generation_exceptions").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("status", "open")
  if (error) throw new Error(`Failed to check PO exceptions: ${error.message}`)
  return (count ?? 0) > 0
}

export async function isPurchasingEnabled(orgId?: string, communityId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeGeneration("price_book.read", undefined, orgId)
  const access = await getDivisionAccessForUser({ orgId: resolvedOrgId, userId })
  let query = supabase.from("vendor_price_agreements").select("id").eq("org_id", resolvedOrgId).eq("status", "active").limit(1)
  if (communityId) {
    if (access.assignedOnly) {
      const { data: community } = await supabase.from("communities").select("division_id").eq("org_id", resolvedOrgId).eq("id", communityId).maybeSingle()
      if (!community?.division_id || !access.divisionIds.includes(community.division_id)) return false
    }
    query = query.or(`community_id.eq.${communityId},community_id.is.null`)
  } else if (access.assignedOnly) {
    if (access.divisionIds.length === 0) return false
    const { data: communities, error: communityError } = await supabase.from("communities").select("id").eq("org_id", resolvedOrgId).in("division_id", access.divisionIds)
    if (communityError) throw new Error(`Failed to scope purchasing readiness: ${communityError.message}`)
    const communityIds = (communities ?? []).map((community) => community.id)
    query = query.or([
      `division_id.in.(${access.divisionIds.join(",")})`,
      communityIds.length ? `community_id.in.(${communityIds.join(",")})` : null,
      "and(division_id.is.null,community_id.is.null)",
    ].filter(Boolean).join(","))
  }
  const { data, error } = await query
  if (error) throw new Error(`Failed to check purchasing readiness: ${error.message}`)
  return (data ?? []).length > 0
}
