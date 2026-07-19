import type { CostType } from "@/lib/cost-types"

export type PlanPricingSource =
  | "price_agreement"
  | "takeoff_manual"
  | "cost_code_default"
  | "unpriced"

export type PlanTakeoffPricingLine = {
  id: string
  elevation_id: string | null
  cost_code_id: string
  cost_type: CostType | null
  description: string
  quantity: number
  uom: string
  unit_cost_cents: number | null
  sort_order: number
}

export type ResolvedPlanPricingLine = PlanTakeoffPricingLine & {
  resolved_unit_cost_cents: number
  amount_cents: number
  pricing_source: PlanPricingSource
  vendor_id: string | null
}

export type GroupedPlanBudgetLine = {
  cost_code_id: string | null
  cost_type: CostType | null
  description: string
  amount_cents: number
  source_line_ids: string[]
  pricing_sources: PlanPricingSource[]
}

export type TemplateBasisLine = {
  amount_cents: number | null
  quantity: number | null
  unit_cost_cents: number | null
}

export type TakeoffDiff = {
  key: string
  classification: "added" | "removed" | "changed"
  before_quantity: number | null
  after_quantity: number | null
  manual_price_delta_cents: number
}

export function resolveTemplateLineAmount(line: TemplateBasisLine): number {
  if (line.amount_cents != null) return Math.round(line.amount_cents)
  return Math.round((line.quantity ?? 0) * (line.unit_cost_cents ?? 0))
}

export function resolveTakeoffLineAmount(quantity: number, unitCostCents: number): number {
  return Math.round(quantity * unitCostCents)
}

export function selectTakeoffLinesForElevation(
  lines: PlanTakeoffPricingLine[],
  elevationId: string | null,
): PlanTakeoffPricingLine[] {
  return lines.filter((line) => line.elevation_id === null || line.elevation_id === elevationId)
}

export function choosePlanPrice({
  agreement,
  manualUnitCostCents,
  costCodeDefaultCents,
}: {
  agreement?: { unitPriceCents: number; vendorId: string | null; source?: Exclude<PlanPricingSource, "unpriced"> } | null
  manualUnitCostCents: number | null
  costCodeDefaultCents: number | null
}): { unitCostCents: number; source: PlanPricingSource; vendorId: string | null } {
  if (agreement) {
    return {
      unitCostCents: agreement.unitPriceCents,
      source: agreement.source ?? "price_agreement",
      vendorId: agreement.vendorId,
    }
  }
  if (manualUnitCostCents !== null) {
    return { unitCostCents: manualUnitCostCents, source: "takeoff_manual", vendorId: null }
  }
  if (costCodeDefaultCents !== null) {
    return { unitCostCents: costCodeDefaultCents, source: "cost_code_default", vendorId: null }
  }
  return { unitCostCents: 0, source: "unpriced", vendorId: null }
}

export function groupResolvedPlanLines(
  lines: ResolvedPlanPricingLine[],
  costCodesEnabled: boolean,
): GroupedPlanBudgetLine[] {
  const groups = new Map<string, GroupedPlanBudgetLine>()
  lines.forEach((line, index) => {
    const key = costCodesEnabled ? line.cost_code_id : `line:${index}`
    const current = groups.get(key) ?? {
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
      cost_type: line.cost_type,
      description: line.description,
      amount_cents: 0,
      source_line_ids: [],
      pricing_sources: [],
    }
    current.amount_cents += line.amount_cents
    current.source_line_ids.push(line.id)
    if (!current.pricing_sources.includes(line.pricing_source)) {
      current.pricing_sources.push(line.pricing_source)
    }
    if (!current.description.split("; ").includes(line.description)) {
      current.description = `${current.description}; ${line.description}`
    }
    groups.set(key, current)
  })
  return Array.from(groups.values())
}

function driftKey(line: PlanTakeoffPricingLine): string {
  return [line.elevation_id ?? "base", line.cost_code_id, line.description.trim(), line.uom].join("|")
}

export function diffPlanTakeoffs(
  before: PlanTakeoffPricingLine[],
  after: PlanTakeoffPricingLine[],
): TakeoffDiff[] {
  const beforeByKey = new Map(before.map((line) => [driftKey(line), line]))
  const afterByKey = new Map(after.map((line) => [driftKey(line), line]))
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()])
  const changes: TakeoffDiff[] = []
  for (const key of keys) {
    const oldLine = beforeByKey.get(key)
    const newLine = afterByKey.get(key)
    if (!oldLine && newLine) {
      changes.push({
        key,
        classification: "added",
        before_quantity: null,
        after_quantity: newLine.quantity,
        manual_price_delta_cents: resolveTakeoffLineAmount(newLine.quantity, newLine.unit_cost_cents ?? 0),
      })
      continue
    }
    if (oldLine && !newLine) {
      changes.push({
        key,
        classification: "removed",
        before_quantity: oldLine.quantity,
        after_quantity: null,
        manual_price_delta_cents: -resolveTakeoffLineAmount(oldLine.quantity, oldLine.unit_cost_cents ?? 0),
      })
      continue
    }
    if (!oldLine || !newLine) continue
    const oldAmount = resolveTakeoffLineAmount(oldLine.quantity, oldLine.unit_cost_cents ?? 0)
    const newAmount = resolveTakeoffLineAmount(newLine.quantity, newLine.unit_cost_cents ?? 0)
    if (oldLine.quantity !== newLine.quantity || oldLine.unit_cost_cents !== newLine.unit_cost_cents) {
      changes.push({
        key,
        classification: "changed",
        before_quantity: oldLine.quantity,
        after_quantity: newLine.quantity,
        manual_price_delta_cents: newAmount - oldAmount,
      })
    }
  }
  return changes
}
