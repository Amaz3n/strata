import { takeoffLineKey } from "@/lib/financials/plan-pricing"
import type { PlanPricingSource } from "@/lib/financials/plan-pricing"
import { resolveTakeoffLineAmount } from "@/lib/financials/plan-pricing"
import type { TakeoffLineDto } from "@/lib/services/house-plans"
import type { CostCode } from "@/lib/types"

/**
 * The takeoff as an estimator reads it: grouped into cost-code divisions, and
 * always positioned against the edition currently being built. A release is an
 * argument about what changed, so the change is the structure of the document
 * rather than a report you open afterwards.
 *
 * Pure and client-safe — the plan sheet computes the bill in the browser as the
 * draft is edited, without a round trip per keystroke. Pricing is resolved by the
 * caller and passed in; this module only groups, diffs, and sums.
 */

export type BillRowStatus = "added" | "removed" | "changed" | "same"

export type BillRow = {
  /** Stable across edits — a React key, never a comparison identity. */
  key: string
  /** What makes two lines "the same line" across editions. */
  matchKey: string
  /** Index into the editable draft array; -1 for a line that only exists in the comparison. */
  index: number
  costCodeId: string
  costCode: string
  costCodeName: string
  description: string
  uom: string
  quantity: number
  elevationId: string | null
  /** Effective unit cost after price-book resolution, in cents. */
  unitCostCents: number | null
  amountCents: number
  comparisonAmountCents: number | null
  deltaCents: number | null
  status: BillRowStatus
  /** Null on a removed row, which has no live pricing. */
  pricingSource: PlanPricingSource | null
  vendorName: string | null
  /** True when an agreement prices the line as a lump sum regardless of quantity. */
  lumpSum: boolean
  unpriced: boolean
  /** Set when the draft row cannot be saved as-is. */
  invalid: boolean
}

export type BillDivision = {
  key: string
  label: string
  rows: BillRow[]
  amountCents: number
  comparisonAmountCents: number | null
  deltaCents: number | null
  sharePct: number
  unpricedCount: number
  changedCount: number
}

export type Bill = {
  divisions: BillDivision[]
  amountCents: number
  comparisonAmountCents: number | null
  deltaCents: number | null
  lineCount: number
  unpricedCount: number
  changedCount: number
  invalidCount: number
}

const UNCODED_KEY = "__uncoded"

/** Division headers are seeded as cost codes of their own; they name the group. */
function divisionLabels(costCodes: CostCode[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const code of costCodes) {
    if (!code.division) continue
    if (code.category === "csi-division" || code.category === "nahb-group") {
      labels.set(code.division, code.name)
    }
  }
  return labels
}

export type BillLineInput = {
  /** Stable identity for the draft row, independent of its contents. */
  uid: string
  index: number
  costCodeId: string
  description: string
  uom: string
  quantity: number
  elevationId: string | null
  /** Effective unit cost — the caller has already applied price-book precedence. */
  unitCostCents: number | null
  amountCents: number
  pricingSource: PlanPricingSource
  vendorName: string | null
  lumpSum: boolean
  invalid: boolean
}

function keyOf(line: { elevationId: string | null; costCodeId: string; description: string; uom: string }): string {
  return takeoffLineKey({
    id: "",
    elevation_id: line.elevationId,
    cost_code_id: line.costCodeId,
    cost_type: null,
    description: line.description,
    quantity: 0,
    uom: line.uom,
    unit_cost_cents: null,
    sort_order: 0,
  })
}

export function buildBill({
  lines,
  comparisonLines,
  costCodes,
}: {
  lines: BillLineInput[]
  /** The released edition's lines, or null when there is nothing to compare against. */
  comparisonLines: TakeoffLineDto[] | null
  costCodes: CostCode[]
}): Bill {
  const codeById = new Map(costCodes.map((code) => [code.id, code]))
  const labels = divisionLabels(costCodes)

  const comparisonByKey = new Map(
    (comparisonLines ?? []).map((line) => [
      takeoffLineKey(line),
      resolveTakeoffLineAmount(line.quantity, line.unit_cost_cents ?? 0),
    ]),
  )
  const seen = new Set<string>()

  const rows: BillRow[] = lines.map((line) => {
    const code = codeById.get(line.costCodeId)
    const matchKey = keyOf(line)
    seen.add(matchKey)
    const comparison = comparisonByKey.get(matchKey) ?? null
    const deltaCents = comparisonLines ? line.amountCents - (comparison ?? 0) : null
    return {
      key: line.uid,
      matchKey,
      index: line.index,
      costCodeId: line.costCodeId,
      costCode: code?.code ?? "—",
      costCodeName: code?.name ?? "Uncoded",
      description: line.description,
      uom: line.uom,
      quantity: line.quantity,
      elevationId: line.elevationId,
      unitCostCents: line.unitCostCents,
      amountCents: line.amountCents,
      comparisonAmountCents: comparison,
      deltaCents,
      status: !comparisonLines ? "same" : comparison == null ? "added" : deltaCents === 0 ? "same" : "changed",
      pricingSource: line.pricingSource,
      vendorName: line.vendorName,
      lumpSum: line.lumpSum,
      unpriced: line.pricingSource === "unpriced",
      invalid: line.invalid,
    }
  })

  // A line the released edition had and this one does not is the most expensive
  // kind of change to miss, so it stays in the document as a removal.
  for (const line of comparisonLines ?? []) {
    const matchKey = takeoffLineKey(line)
    if (seen.has(matchKey)) continue
    const code = codeById.get(line.cost_code_id)
    const comparison = comparisonByKey.get(matchKey) ?? 0
    rows.push({
      key: `removed:${matchKey}`,
      matchKey,
      index: -1,
      costCodeId: line.cost_code_id,
      costCode: code?.code ?? "—",
      costCodeName: code?.name ?? "Uncoded",
      description: line.description,
      uom: line.uom,
      quantity: line.quantity,
      elevationId: line.elevation_id,
      unitCostCents: line.unit_cost_cents,
      amountCents: 0,
      comparisonAmountCents: comparison,
      deltaCents: -comparison,
      status: "removed",
      pricingSource: null,
      vendorName: null,
      lumpSum: false,
      unpriced: false,
      invalid: false,
    })
  }

  const groups = new Map<string, BillRow[]>()
  for (const row of rows) {
    const division = codeById.get(row.costCodeId)?.division?.trim() || UNCODED_KEY
    const group = groups.get(division) ?? []
    group.push(row)
    groups.set(division, group)
  }

  const amountCents = rows.reduce((sum, row) => sum + row.amountCents, 0)

  const divisions: BillDivision[] = Array.from(groups.entries())
    .map(([key, groupRows]) => {
      const sorted = groupRows.slice().sort((left, right) => {
        const byCode = left.costCode.localeCompare(right.costCode, undefined, { numeric: true })
        // Lines sharing a code keep the order they were entered in, so a row the
        // estimator just added lands where they are looking.
        return byCode !== 0 ? byCode : left.index - right.index
      })
      const groupAmount = sorted.reduce((sum, row) => sum + row.amountCents, 0)
      const groupComparison = comparisonLines
        ? sorted.reduce((sum, row) => sum + (row.comparisonAmountCents ?? 0), 0)
        : null
      return {
        key,
        label: key === UNCODED_KEY ? "Uncoded" : labels.get(key) ?? `Division ${key}`,
        rows: sorted,
        amountCents: groupAmount,
        comparisonAmountCents: groupComparison,
        deltaCents: groupComparison == null ? null : groupAmount - groupComparison,
        sharePct: amountCents > 0 ? (groupAmount / amountCents) * 100 : 0,
        unpricedCount: sorted.filter((row) => row.unpriced).length,
        changedCount: sorted.filter((row) => row.status !== "same").length,
      }
    })
    .sort((left, right) => {
      if (left.key === UNCODED_KEY) return 1
      if (right.key === UNCODED_KEY) return -1
      return left.key.localeCompare(right.key, undefined, { numeric: true })
    })

  const comparisonTotal = comparisonLines ? rows.reduce((sum, row) => sum + (row.comparisonAmountCents ?? 0), 0) : null

  return {
    divisions,
    amountCents,
    comparisonAmountCents: comparisonTotal,
    deltaCents: comparisonTotal == null ? null : amountCents - comparisonTotal,
    lineCount: rows.filter((row) => row.status !== "removed").length,
    unpricedCount: rows.filter((row) => row.unpriced).length,
    changedCount: rows.filter((row) => row.status !== "same").length,
    invalidCount: rows.filter((row) => row.invalid).length,
  }
}
