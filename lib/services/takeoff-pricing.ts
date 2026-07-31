import "server-only"

/**
 * What this builder actually pays, per unit, per cost code.
 *
 * The rate on a takeoff condition should never be a guess and never a national
 * cost book. Arc already holds the evidence: signed subcontract lines, standing
 * vendor price agreements, and the cost code's own default. This turns that
 * into a p25 / median / p75 band plus the individual jobs behind it, so an
 * estimator can accept a number and then show their work.
 *
 * Only unit-priced records count. A lump-sum commitment line has no rate to
 * extract, and pretending otherwise (amount ÷ some quantity) would manufacture
 * a number nobody agreed to.
 */

import { requireOrgContext } from "@/lib/services/context"
import { hasPermission, requirePermission } from "@/lib/services/permissions"

/** Samples per source, newest first. Enough to be evidence, not a report. */
const SAMPLE_CAP = 40
/** Evidence rows handed to the UI. */
const EVIDENCE_CAP = 8

export interface RateSample {
  source: "commitment" | "price_agreement"
  unit_cost_cents: number
  unit: string | null
  /** Project or community the rate was paid on; null for org-wide agreements. */
  context_label: string | null
  vendor_name: string | null
  dated: string | null
}

export interface CostCodeRateHistory {
  cost_code_id: string
  /** Null when there is nothing to report — the UI shows the cost-code default silently. */
  p25_cents: number | null
  median_cents: number | null
  p75_cents: number | null
  sample_count: number
  /** Most common unit across the samples; a mismatch with the condition is worth flagging. */
  unit: string | null
  /** The cost code's own default, always returned as the no-history fallback. */
  default_unit_cost_cents: number | null
  /** Newest evidence, capped. */
  evidence: RateSample[]
  /**
   * False when the caller may see quantities but not what the builder paid.
   * Everything above is empty in that case — the gate is enforced here, not
   * in the component.
   */
  visible: boolean
}

/**
 * Linear-interpolated percentile over a sorted array. Matches the convention
 * used elsewhere in Arc's reporting so a takeoff band and a report band agree.
 */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower))
}

export async function getCostCodeRateHistory(
  costCodeId: string,
  orgId?: string,
): Promise<CostCodeRateHistory> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: costCode } = await supabase
    .from("cost_codes")
    .select("id, unit, default_unit_cost_cents")
    .eq("org_id", resolvedOrgId)
    .eq("id", costCodeId)
    .maybeSingle()

  const empty: CostCodeRateHistory = {
    cost_code_id: costCodeId,
    p25_cents: null,
    median_cents: null,
    p75_cents: null,
    sample_count: 0,
    unit: costCode?.unit ?? null,
    default_unit_cost_cents: costCode?.default_unit_cost_cents ?? null,
    evidence: [],
    visible: true,
  }

  if (!costCode) return { ...empty, default_unit_cost_cents: null }

  // Historical cost is margin-adjacent: the same gate that hides markup on an
  // estimate hides what the builder paid a sub here.
  const canSeeCost = await hasPermission("financials.margin.read", {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
  if (!canSeeCost) return { ...empty, visible: false }

  const [commitments, agreements] = await Promise.all([
    loadCommitmentRates(supabase, resolvedOrgId, costCodeId),
    loadPriceAgreementRates(supabase, resolvedOrgId, costCodeId),
  ])

  const samples = [...commitments, ...agreements]
  if (samples.length === 0) return empty

  const values = samples.map((s) => s.unit_cost_cents).sort((a, b) => a - b)
  const unitCounts = new Map<string, number>()
  for (const sample of samples) {
    if (!sample.unit) continue
    unitCounts.set(sample.unit, (unitCounts.get(sample.unit) ?? 0) + 1)
  }
  const dominantUnit =
    Array.from(unitCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? costCode.unit ?? null

  return {
    ...empty,
    p25_cents: percentile(values, 0.25),
    median_cents: percentile(values, 0.5),
    p75_cents: percentile(values, 0.75),
    sample_count: samples.length,
    unit: dominantUnit,
    evidence: samples
      .sort((a, b) => (b.dated ?? "").localeCompare(a.dated ?? ""))
      .slice(0, EVIDENCE_CAP),
  }
}

async function loadCommitmentRates(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  costCodeId: string,
): Promise<RateSample[]> {
  const { data } = await supabase
    .from("commitment_lines")
    .select(
      "unit_cost_cents, unit, quantity, commitments!inner(id, status, created_at, projects(name), companies(name))",
    )
    .eq("org_id", orgId)
    .eq("cost_code_id", costCodeId)
    .not("unit_cost_cents", "is", null)
    .gt("unit_cost_cents", 0)
    .limit(SAMPLE_CAP)

  return (data ?? [])
    .filter((row: any) => {
      // A line with qty 1 and no unit is a lump sum wearing a unit rate's
      // clothes; it says nothing about price per square foot.
      const quantity = Number(row.quantity ?? 0)
      return quantity > 0 && !!row.unit
    })
    .map((row: any) => ({
      source: "commitment" as const,
      unit_cost_cents: Number(row.unit_cost_cents),
      unit: row.unit ?? null,
      context_label: row.commitments?.projects?.name ?? null,
      vendor_name: row.commitments?.companies?.name ?? null,
      dated: row.commitments?.created_at ?? null,
    }))
}

async function loadPriceAgreementRates(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  costCodeId: string,
): Promise<RateSample[]> {
  const { data } = await supabase
    .from("vendor_price_agreements")
    .select(
      "unit_cost_cents, uom, status, effective_from, pricing_kind, companies(name), communities(name)",
    )
    .eq("org_id", orgId)
    .eq("cost_code_id", costCodeId)
    .eq("status", "active")
    .eq("pricing_kind", "unit")
    .not("unit_cost_cents", "is", null)
    .gt("unit_cost_cents", 0)
    .order("effective_from", { ascending: false })
    .limit(SAMPLE_CAP)

  return (data ?? []).map((row: any) => ({
    source: "price_agreement" as const,
    unit_cost_cents: Number(row.unit_cost_cents),
    unit: row.uom ?? null,
    context_label: row.communities?.name ?? null,
    vendor_name: row.companies?.name ?? null,
    dated: row.effective_from ?? null,
  }))
}
