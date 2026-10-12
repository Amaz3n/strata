import "server-only"

import { z } from "zod"

import {
  homeMarginBaseline,
  baselineOptionsCostCents,
  type BaselineOption,
  type HomeMarginBaselineStage,
} from "@/lib/financials/home-margin-baseline"
import { readAllRowsById } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** One home's selections. Past this the capture fails rather than understating cost. */
const SELECTION_ROW_CAP = 5_000
const LIVE_SELECTION_STATUSES = ["confirmed", "ordered", "received"]

const pricedItemSchema = z.object({
  optionId: z.string().optional(),
  packageId: z.string().optional(),
  priceCents: z.number().int(),
})

/** The parts of a purchase agreement's pricing a baseline reads. */
const agreementPricingSchema = z.object({
  lotPremiumCents: z.number().int(),
  structuralOptions: z.array(pricedItemSchema),
  designSelections: z.array(pricedItemSchema),
  structuralOptionsCents: z.number().int(),
  designSelectionsCents: z.number().int(),
  incentivesCents: z.number().int(),
  /** The catalog revision the quote was priced against: a bigint, carried as digits. */
  catalogRevision: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable().optional(),
})
type AgreementPricing = z.infer<typeof agreementPricingSchema>

const agreementSnapshotSchema = z.object({ purchase_agreement: z.object({ pricing: agreementPricingSchema }) })

/** A budget generated with the home's purchase orders already prices its options. */
const budgetSourceSchema = z.object({ source: z.string() })

type SelectionRow = {
  id: string
  selected_option_id: string | null
  package_id: string | null
  price_cents_snapshot: number | null
  cost_cents_snapshot: number | null
}

export type HomeMarginBaselineDto = {
  id: string
  projectId: string
  contractId: string | null
  stage: HomeMarginBaselineStage
  salePriceCents: number | null
  incentivesCents: number | null
  lotPremiumCents: number | null
  optionsPriceCents: number | null
  baseCostCents: number | null
  optionsCostCents: number | null
  costCents: number | null
  marginCents: number | null
  marginBps: number | null
  catalogRevision: string | null
  capturedAt: string
}

const baselineRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  contract_id: z.string().nullable(),
  stage: z.enum(["agreement", "release"]),
  sale_price_cents: z.number().int().nullable(),
  incentives_cents: z.number().int().nullable(),
  lot_premium_cents: z.number().int().nullable(),
  options_price_cents: z.number().int().nullable(),
  base_cost_cents: z.number().int().nullable(),
  options_cost_cents: z.number().int().nullable(),
  cost_cents: z.number().int().nullable(),
  margin_cents: z.number().int().nullable(),
  margin_bps: z.number().int().nullable(),
  catalog_revision: z.union([z.string(), z.number().int()]).nullable(),
  captured_at: z.string(),
})

function mapBaseline(row: unknown): HomeMarginBaselineDto {
  const parsed = baselineRowSchema.parse(row)
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    contractId: parsed.contract_id,
    stage: parsed.stage,
    salePriceCents: parsed.sale_price_cents,
    incentivesCents: parsed.incentives_cents,
    lotPremiumCents: parsed.lot_premium_cents,
    optionsPriceCents: parsed.options_price_cents,
    baseCostCents: parsed.base_cost_cents,
    optionsCostCents: parsed.options_cost_cents,
    costCents: parsed.cost_cents,
    marginCents: parsed.margin_cents,
    marginBps: parsed.margin_bps,
    catalogRevision: parsed.catalog_revision === null ? null : String(parsed.catalog_revision),
    capturedAt: parsed.captured_at,
  }
}

const BASELINE_COLUMNS = "id,project_id,contract_id,stage,sale_price_cents,incentives_cents,lot_premium_cents,options_price_cents,base_cost_cents,options_cost_cents,cost_cents,margin_cents,margin_bps,catalog_revision,captured_at"

/**
 * The options a signed agreement priced, each costed by the confirmed selection
 * that buys it. An item no selection costs (a design choice not yet written to
 * the home, a package whose members are uncosted) is an unknown cost.
 */
function agreementOptions(pricing: AgreementPricing, selections: SelectionRow[]): BaselineOption[] {
  return [...pricing.structuralOptions, ...pricing.designSelections].map((item) => {
    const members = item.optionId
      ? selections.filter((row) => row.selected_option_id === item.optionId)
      : item.packageId ? selections.filter((row) => row.package_id === item.packageId) : []
    const costed = members.length > 0 && members.every((row) => row.cost_cents_snapshot !== null)
    return { priceCents: item.priceCents, costCents: costed ? members.reduce((total, row) => total + Number(row.cost_cents_snapshot), 0) : null }
  })
}

/**
 * Record what a home was sold at (`agreement`, once its purchase agreement is
 * executed) or released at (`release`, once its start package publishes and its
 * budget exists). Runs as an effect of those two transitions, which have already
 * authorized their actor, so it writes with the service role. Each stage is
 * captured once: a re-run — a retried webhook, a recovered release — finds the
 * row and changes nothing, and a later catalog or price change never reaches it.
 *
 * Sale price is the binding agreement's total; a spec home released without one
 * is priced at its asking price (`sellable_lot_inventory`). Cost is the home's
 * newest budget plus the selections' cost snapshots; a home with no budget yet
 * (most homes at agreement) has no known base cost, so its margin is recorded
 * as unknown rather than estimated.
 */
export async function captureHomeMarginBaseline(input: {
  orgId: string
  projectId: string
  stage: HomeMarginBaselineStage
  actorId?: string | null
}): Promise<HomeMarginBaselineDto> {
  const supabase = createServiceSupabaseClient()
  const { orgId, projectId, stage } = input
  const fail = (message: string) => new Error(`Failed to capture the home's ${stage} margin baseline: ${message}`)

  const [contractResult, budgetResult, selections] = await Promise.all([
    supabase.from("contracts").select("id,total_cents,snapshot")
      .eq("org_id", orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").eq("status", "active")
      .order("signed_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from("budgets").select("id,version,total_cents,metadata")
      .eq("org_id", orgId).eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle(),
    readAllRowsById<SelectionRow>((afterId, limit) => {
      let query = supabase.from("project_selections").select("id,selected_option_id,package_id,price_cents_snapshot,cost_cents_snapshot")
        .eq("org_id", orgId).eq("project_id", projectId).in("status", LIVE_SELECTION_STATUSES)
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<SelectionRow[]>()
    }, { cap: SELECTION_ROW_CAP, label: "Failed to read the home's selections", pageSize: 1000 }),
  ])
  if (contractResult.error) throw fail(contractResult.error.message)
  if (budgetResult.error) throw fail(budgetResult.error.message)
  const contract = contractResult.data
  const budget = budgetResult.data
  if (stage === "agreement" && !contract) throw fail("the home has no executed purchase agreement")

  // One release baseline per home; one agreement baseline per agreement, so a
  // home sold again after a void is baselined on its new sale.
  const captured = () => {
    const query = supabase.from("home_margin_baselines").select(BASELINE_COLUMNS).eq("org_id", orgId).eq("project_id", projectId).eq("stage", stage)
    return stage === "agreement" && contract ? query.eq("contract_id", contract.id).maybeSingle() : query.maybeSingle()
  }
  const { data: existing, error: existingError } = await captured()
  if (existingError) throw fail(existingError.message)
  if (existing) return mapBaseline(existing)

  const parsedSnapshot = contract ? agreementSnapshotSchema.safeParse(contract.snapshot) : null
  const pricing = parsedSnapshot?.success ? parsedSnapshot.data.purchase_agreement.pricing : null
  if (stage === "agreement" && !pricing) throw fail("the agreement carries no pricing snapshot")

  let salePriceCents: number | null = contract ? Number(contract.total_cents) : null
  if (!contract) {
    const { data: inventory, error } = await supabase.from("sellable_lot_inventory").select("asking_price_cents")
      .eq("org_id", orgId).eq("project_id", projectId).maybeSingle()
    if (error) throw fail(error.message)
    salePriceCents = inventory?.asking_price_cents == null ? null : Number(inventory.asking_price_cents)
  }

  const options: BaselineOption[] = stage === "agreement" && pricing
    ? agreementOptions(pricing, selections)
    : selections.map((row) => ({ priceCents: Number(row.price_cents_snapshot ?? 0), costCents: row.cost_cents_snapshot === null ? null : Number(row.cost_cents_snapshot) }))
  const budgetCoversOptions = budgetSourceSchema.safeParse(budget?.metadata).data?.source === "po_generation"
  const figures = homeMarginBaseline({
    salePriceCents,
    budgetCents: budget ? Number(budget.total_cents ?? 0) : null,
    budgetCoversOptions,
    optionsCostCents: baselineOptionsCostCents(options),
  })

  const row = {
    org_id: orgId,
    project_id: projectId,
    contract_id: contract?.id ?? null,
    stage,
    sale_price_cents: salePriceCents,
    incentives_cents: pricing ? pricing.incentivesCents : contract ? null : 0,
    lot_premium_cents: pricing?.lotPremiumCents ?? null,
    options_price_cents: pricing ? pricing.structuralOptionsCents + pricing.designSelectionsCents : null,
    base_cost_cents: figures.baseCostCents,
    options_cost_cents: figures.optionsCostCents,
    cost_cents: figures.costCents,
    margin_cents: figures.marginCents,
    margin_bps: figures.marginBps,
    catalog_revision: pricing?.catalogRevision ?? null,
    basis: {
      sale_price_source: contract ? "purchase_agreement" : "asking_price",
      budget_id: budget?.id ?? null,
      budget_version: budget?.version ?? null,
      budget_covers_options: budgetCoversOptions,
      option_count: options.length,
    },
    captured_at: new Date().toISOString(),
    captured_by: input.actorId ?? null,
  }
  const { data: inserted, error: insertError } = await supabase.from("home_margin_baselines").insert(row).select(BASELINE_COLUMNS).single()
  if (insertError?.code === "23505") {
    // A concurrent capture of the same stage won; its row is the baseline.
    const { data: winner, error: winnerError } = await captured()
    if (winnerError || !winner) throw fail(winnerError?.message ?? "the concurrent capture is not readable")
    return mapBaseline(winner)
  }
  if (insertError || !inserted) throw fail(insertError?.message ?? "no row was written")
  const baseline = mapBaseline(inserted)

  await Promise.all([
    recordEvent({
      orgId, actorId: input.actorId ?? null, eventType: "home_margin_baseline_captured", entityType: "project", entityId: projectId,
      payload: { stage, baseline_id: baseline.id, sale_price_cents: baseline.salePriceCents, margin_cents: baseline.marginCents, margin_bps: baseline.marginBps },
    }),
    recordAudit({
      orgId, actorId: input.actorId ?? undefined, action: "insert", entityType: "home_margin_baseline", entityId: baseline.id,
      after: { ...row, id: baseline.id }, source: `home_margin_baseline.${stage}`,
    }),
  ])
  return baseline
}
