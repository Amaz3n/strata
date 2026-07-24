import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { resolvePriceForLinePure, resolvedPriceTotal, type PriceAgreementCandidate } from "@/lib/financials/price-resolution"
import {
  createPoGenerationFingerprint,
  groupGeneratedBudgetLines,
  groupPurchaseOrderLines,
  type PoGenerationResolvedLine,
} from "@/lib/financials/po-generation-math"
import { recordAudit } from "@/lib/services/audit"
import {
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
  requireAuthorization,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
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

export type PoGenerationResult = {
  runId: string
  mode: "dry_run" | "commit"
  status: "succeeded" | "succeeded_with_exceptions" | "failed"
  inputFingerprint: string
  purchaseOrders: ReturnType<typeof groupPurchaseOrderLines>
  exceptions: GenerationException[]
  budgetLinesWritten: number
}

function relation<T extends Record<string, unknown>>(value: unknown): T | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as T : null
}

async function authorizeGeneration(permission: "po.generate" | "price_book.read" | "po_exception.resolve", projectId?: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission, userId: context.userId, orgId: context.orgId, projectId,
    supabase: context.supabase, logDecision: true, resourceType: projectId ? "project" : undefined, resourceId: projectId,
  })
  return context
}

export async function generatePurchaseOrders(args: { projectId: string; mode: "dry_run" | "commit"; asOfDate?: string; orgId?: string }): Promise<PoGenerationResult> {
  const parsed = poGenerationInputSchema.parse(args)
  const { supabase, orgId, userId } = await authorizeGeneration("po.generate", parsed.projectId, args.orgId)
  const asOfDate = parsed.asOfDate ?? new Date().toISOString().slice(0, 10)

  const { data: lot, error: lotError } = await supabase.from("lots").select(`
    id, project_id, community_id, division_id, lot_number, block, house_plan_id,
    house_plan_version_id, house_plan_elevation_id,
    community:communities(name, division_id), house_plan:house_plans(name)
  `).eq("org_id", orgId).eq("project_id", parsed.projectId).maybeSingle()
  if (lotError || !lot?.house_plan_version_id || !lot.house_plan_id) {
    throw new Error("The project must be linked to a lot with a pinned house plan version before PO generation.")
  }

  const [{ data: takeoffs, error: takeoffError }, { data: selections, error: selectionError }] = await Promise.all([
    supabase.from("house_plan_takeoff_lines").select("id,cost_code_id,cost_type,description,quantity,uom,elevation_id")
      .eq("org_id", orgId).eq("house_plan_version_id", lot.house_plan_version_id).order("sort_order"),
    supabase.from("project_selections").select(`
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
  const [{ data: agreements, error: agreementError }, { data: companies, error: companyError }] = await Promise.all([
    costCodeIds.length > 0
      ? supabase.from("vendor_price_agreements").select("*").eq("org_id", orgId).in("cost_code_id", costCodeIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("companies").select("id,name").eq("org_id", orgId).order("name").limit(10_000),
  ])
  if (agreementError) throw new Error(`Failed to load price agreements: ${agreementError.message}`)
  if (companyError) throw new Error(`Failed to load vendors: ${companyError.message}`)
  const companyNames = new Map((companies ?? []).map((company) => [String(company.id), String(company.name)]))
  const companyByNormalizedName = new Map((companies ?? []).map((company) => [String(company.name).trim().toLowerCase(), String(company.id)]))
  const candidates = (agreements ?? []) as PriceAgreementCandidate[]
  const { data: priorResolutions, error: resolutionError } = await supabase.from("po_generation_exceptions")
    .select("source_kind,source_ref,resolution,resolved_at").eq("org_id", orgId).eq("project_id", parsed.projectId)
    .in("status", ["resolved_agreement", "resolved_manual"]).order("resolved_at", { ascending: false }).limit(1000)
  if (resolutionError) throw new Error(`Failed to load PO exception resolutions: ${resolutionError.message}`)
  const resolutionBySource = new Map<string, Record<string, unknown>>()
  for (const row of priorResolutions ?? []) {
    const sourceRef = row.source_ref as Record<string, unknown>
    const sourceId = row.source_kind === "takeoff_line" ? sourceRef.takeoff_line_id : sourceRef.project_selection_id
    const key = `${row.source_kind}:${String(sourceId ?? "")}`
    if (!resolutionBySource.has(key) && row.resolution && typeof row.resolution === "object") resolutionBySource.set(key, row.resolution as Record<string, unknown>)
  }
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
    const override = resolutionBySource.get(`takeoff_line:${line.id}`)
    if (override?.kind === "manual" && typeof override.company_id === "string" && typeof override.unit_cost_cents === "number") {
      const totalCents = Math.round(Number(line.quantity) * override.unit_cost_cents)
      resolvedLines.push({ sourceKind: "takeoff_line", sourceId: line.id, companyId: override.company_id, companyName: companyNames.get(override.company_id) ?? "Unknown vendor", agreementId: `manual:${line.id}`, costCodeId: line.cost_code_id, costType: line.cost_type, description: line.description, quantity: Number(line.quantity), unit: line.uom, unitCostCents: override.unit_cost_cents, totalCents, scopeText: typeof override.note === "string" ? override.note : undefined })
      continue
    }
    const chosenAgreement = override?.kind === "agreement" && typeof override.agreement_id === "string"
      ? candidates.find((candidate) => candidate.id === override.agreement_id && candidate.cost_code_id === line.cost_code_id)
      : undefined
    const result = chosenAgreement
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
    const override = resolutionBySource.get(`option:${sourceId}`)
    if (override?.kind === "manual" && typeof override.company_id === "string" && typeof override.unit_cost_cents === "number") {
      resolvedLines.push({ sourceKind: "option", sourceId, companyId: override.company_id, companyName: companyNames.get(override.company_id) ?? "Unknown vendor", agreementId: `manual:${sourceId}`, costCodeId, costType: null, description: descriptor, quantity: 1, unit: "ea", unitCostCents: override.unit_cost_cents, totalCents: override.unit_cost_cents, optionDescriptor: descriptor, scopeText: typeof override.note === "string" ? override.note : undefined })
      continue
    }
    const candidatePool = hintedCompanyId ? candidates.filter((candidate) => candidate.company_id === hintedCompanyId) : candidates
    const chosenAgreement = override?.kind === "agreement" && typeof override.agreement_id === "string"
      ? candidatePool.find((candidate) => candidate.id === override.agreement_id && candidate.cost_code_id === costCodeId)
      : undefined
    const priceResult = chosenAgreement
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

  const purchaseOrders = groupPurchaseOrderLines(resolvedLines)
  const budgetLines = groupGeneratedBudgetLines(resolvedLines)
  const inputFingerprint = createPoGenerationFingerprint({
    asOfDate,
    lines: [
      ...resolvedLines.map((line) => ({ sourceKind: line.sourceKind, sourceId: line.sourceId, quantity: line.quantity, unit: line.unit, agreementId: line.agreementId, totalCents: line.totalCents })),
      ...exceptions.map((item) => ({ sourceKind: item.source_kind, sourceId: Object.values(item.source_ref)[0] ?? item.description, quantity: item.quantity, unit: item.uom, agreementId: null, totalCents: null })),
    ],
  })

  const { data: prior } = await supabase.from("po_generation_runs").select("id,input_fingerprint,status,summary")
    .eq("org_id", orgId).eq("project_id", parsed.projectId).eq("mode", "commit")
    .in("status", ["succeeded", "succeeded_with_exceptions"]).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (parsed.mode === "commit" && prior?.input_fingerprint === inputFingerprint) {
    return { runId: prior.id, mode: "commit", status: prior.status, inputFingerprint, purchaseOrders, exceptions, budgetLinesWritten: budgetLines.length }
  }

  const summary = {
    po_count: purchaseOrders.length, line_count: resolvedLines.length,
    total_cents: resolvedLines.reduce((sum, line) => sum + line.totalCents, 0),
    exception_count: exceptions.length,
    per_vendor: purchaseOrders.map((po) => ({ company_id: po.companyId, company_name: po.companyName, total_cents: po.totalCents, line_count: po.lines.length })),
  }
  const { data: run, error: runError } = await supabase.from("po_generation_runs").insert({
    org_id: orgId, project_id: parsed.projectId, lot_id: lot.id,
    house_plan_version_id: lot.house_plan_version_id, mode: parsed.mode, status: "running",
    as_of_date: asOfDate, input_fingerprint: inputFingerprint, summary, created_by: userId,
  }).select("id").single()
  if (runError || !run) throw new Error(`Failed to create PO generation run: ${runError?.message}`)

  try {
    if (parsed.mode === "dry_run") {
      if (exceptions.length > 0) {
        const { error: exceptionError } = await supabase.from("po_generation_exceptions").insert(exceptions.map((item) => ({ ...item, org_id: orgId, run_id: run.id, project_id: parsed.projectId })))
        if (exceptionError) throw new Error(`Failed to record PO exceptions: ${exceptionError.message}`)
      }
      const status = exceptions.length ? "succeeded_with_exceptions" : "succeeded"
      await supabase.from("po_generation_runs").update({ status, completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", run.id)
    } else {
      const service = createServiceSupabaseClient()
      const community = relation<Record<string, unknown>>(lot.community)
      const plan = relation<Record<string, unknown>>(lot.house_plan)
      const lotLabel = `${community?.name ?? "Community"} Lot ${lot.lot_number}${lot.block ? ` Block ${lot.block}` : ""}`
      const payload = {
        prior_run_id: prior?.id ?? null,
        total_cents: summary.total_cents,
        summary,
        budget_lines: budgetLines.map((line, index) => ({ cost_code_id: line.costCodeId, cost_type: line.costType, description: line.description, amount_cents: line.amountCents, sort_order: index })),
        purchase_orders: purchaseOrders.map((po, poIndex) => ({
          company_id: po.companyId, total_cents: po.totalCents,
          title: `PO — ${po.lines[0]?.description ?? plan?.name ?? "Trade"} — ${lotLabel}`,
          contract_number: `PO-${lot.lot_number}-${poIndex + 1}`,
          scope: po.lines.map((line) => line.scopeText).filter(Boolean).join("\n"),
          source_agreement_ids: po.sourceAgreementIds,
          lines: po.lines.map((line, index) => ({
            cost_code_id: line.costCodeId, cost_type: line.costType, description: line.description,
            quantity: line.quantity, unit: line.unit, unit_cost_cents: line.unitCostCents,
            total_cents: line.totalCents, source_agreement_id: line.agreementId, sort_order: index,
            metadata: { source: line.sourceKind, source_ref: line.sourceId, option_descriptor: line.optionDescriptor ?? null },
          })),
        })),
        exceptions,
      }
      const { error: commitError } = await service.rpc("run_po_generation_commit", { p_org_id: orgId, p_run_id: run.id, p_payload: payload })
      if (commitError) throw new Error(commitError.message)
    }
  } catch (error) {
    await supabase.from("po_generation_runs").update({ status: "failed", error: error instanceof Error ? error.message : String(error), completed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", run.id)
    throw error
  }

  const status = exceptions.length ? "succeeded_with_exceptions" : "succeeded"
  await recordAudit({ orgId, actorId: userId, action: "insert", entityType: "po_generation_run", entityId: run.id, after: { ...summary, mode: parsed.mode, status } })
  await recordEvent({ orgId, actorId: userId, eventType: "po_generation.completed", entityType: "po_generation_run", entityId: run.id, payload: { project_id: parsed.projectId, mode: parsed.mode, ...summary } })
  return { runId: run.id, mode: parsed.mode, status, inputFingerprint, purchaseOrders, exceptions, budgetLinesWritten: parsed.mode === "commit" ? budgetLines.length : 0 }
}

export async function listGenerationRuns(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await authorizeGeneration("price_book.read", projectId, orgId)
  const { data, error } = await supabase.from("po_generation_runs").select("*").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(50)
  if (error) throw new Error(`Failed to list PO runs: ${error.message}`)
  return data ?? []
}

export async function listPoExceptions({ status = "open", projectId, page = 1, pageSize = 50, orgId }: { status?: string; projectId?: string; page?: number; pageSize?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeGeneration("price_book.read", projectId, orgId)
  const scopedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (scopedProjectIds?.length === 0) return { items: [], count: 0, page, pageSize: Math.min(Math.max(pageSize, 1), 100) }
  const size = Math.min(Math.max(pageSize, 1), 100)
  let query = supabase.from("po_generation_exceptions").select("*, project:projects(name), cost_code:cost_codes(code,name)", { count: "exact" }).eq("org_id", resolvedOrgId).eq("status", status).order("created_at")
  if (projectId) query = query.eq("project_id", projectId)
  if (scopedProjectIds) query = query.in("project_id", scopedProjectIds)
  const { data, error, count } = await query.range((page - 1) * size, page * size - 1)
  if (error) throw new Error(`Failed to list PO exceptions: ${error.message}`)
  return { items: data ?? [], count: count ?? 0, page, pageSize: size }
}

export async function resolvePoException(exceptionId: string, resolution: PoExceptionResolution, orgId?: string) {
  const parsed = poExceptionResolutionSchema.parse(resolution)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeGeneration("po_exception.resolve", undefined, orgId)
  const { data: existing, error: existingError } = await supabase.from("po_generation_exceptions").select("*").eq("org_id", resolvedOrgId).eq("id", exceptionId).maybeSingle()
  if (existingError || !existing) throw new Error("PO exception not found")
  const status = parsed.kind === "agreement" ? "resolved_agreement" : "resolved_manual"
  const { data, error } = await supabase.from("po_generation_exceptions").update({ status, resolution: parsed, resolved_by: userId, resolved_at: new Date().toISOString() }).eq("org_id", resolvedOrgId).eq("id", exceptionId).select("*").single()
  if (error || !data) throw new Error(`Failed to resolve PO exception: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_generation_exception", entityId: exceptionId, before: existing, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_exception.resolved", entityType: "po_generation_exception", entityId: exceptionId, payload: { project_id: existing.project_id } })
  const regeneration = await generatePurchaseOrders({ projectId: existing.project_id, mode: "commit", orgId: resolvedOrgId })
  return { ...data, regeneration }
}

export async function dismissPoException(exceptionId: string, note: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeGeneration("po_exception.resolve", undefined, orgId)
  const { data: existing, error: existingError } = await supabase.from("po_generation_exceptions")
    .select("*").eq("org_id", resolvedOrgId).eq("id", exceptionId).maybeSingle()
  if (existingError || !existing) throw new Error("PO exception not found")
  const { data, error } = await supabase.from("po_generation_exceptions").update({
    status: "dismissed",
    resolution: { note: note.trim() || "Dismissed by purchasing" },
    resolved_by: userId,
    resolved_at: new Date().toISOString(),
  }).eq("org_id", resolvedOrgId).eq("id", exceptionId).select("*").single()
  if (error || !data) throw new Error(`Failed to dismiss PO exception: ${error?.message}`)
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
