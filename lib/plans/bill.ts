import { resolveTakeoffLineAmount, takeoffLineKey } from "@/lib/financials/plan-pricing"
import type { TakeoffLineDto } from "@/lib/services/house-plans"
import type { CostCode } from "@/lib/types"

/**
 * The takeoff as an estimator reads it: grouped into cost-code divisions, and
 * always positioned against the edition currently being built. A release is an
 * argument about what changed, so the change is the structure of the document
 * rather than a report you open afterwards.
 *
 * Pure and client-safe — the plan sheet computes the bill in the browser as the
 * draft is edited, without a round trip per keystroke.
 */

export type BillRowStatus = "added" | "removed" | "changed" | "same"

export type BillRow = {
  key: string
  /** Index into the editable draft array; -1 for a line that only exists in the comparison. */
  index: number
  costCodeId: string
  costCode: string
  costCodeName: string
  description: string
  uom: string
  quantity: number
  elevationId: string | null
  /** Price-book resolution for the current edition, when pricing is available. */
  unitCostCents: number | null
  amountCents: number
  comparisonAmountCents: number | null
  deltaCents: number | null
  status: BillRowStatus
  unpriced: boolean
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
  /** Stable key when the line exists server-side; null for an unsaved draft row. */
  lineId: string | null
  index: number
  costCodeId: string
  description: string
  uom: string
  quantity: number
  unitCostCents: number | null
  elevationId: string | null
  /** Resolved amount when the price book priced it; falls back to qty × unit cost. */
  resolvedAmountCents?: number | null
  unpriced?: boolean
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
    const key = keyOf(line)
    seen.add(key)
    const amountCents =
      line.resolvedAmountCents ?? resolveTakeoffLineAmount(line.quantity, line.unitCostCents ?? 0)
    const comparison = comparisonByKey.get(key) ?? null
    const deltaCents = comparisonLines ? amountCents - (comparison ?? 0) : null
    return {
      key,
      index: line.index,
      costCodeId: line.costCodeId,
      costCode: code?.code ?? "—",
      costCodeName: code?.name ?? "Uncoded",
      description: line.description,
      uom: line.uom,
      quantity: line.quantity,
      elevationId: line.elevationId,
      unitCostCents: line.unitCostCents,
      amountCents,
      comparisonAmountCents: comparison,
      deltaCents,
      status: !comparisonLines ? "same" : comparison == null ? "added" : deltaCents === 0 ? "same" : "changed",
      unpriced: Boolean(line.unpriced),
    }
  })

  // A line the released edition had and this one does not is the most expensive
  // kind of change to miss, so it stays in the document as a removal.
  for (const line of comparisonLines ?? []) {
    const key = takeoffLineKey(line)
    if (seen.has(key)) continue
    const code = codeById.get(line.cost_code_id)
    const comparison = comparisonByKey.get(key) ?? 0
    rows.push({
      key,
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
      unpriced: false,
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
      const sorted = groupRows.slice().sort((left, right) => left.costCode.localeCompare(right.costCode))
      const groupAmount = sorted.reduce((sum, row) => sum + row.amountCents, 0)
      const groupComparison = comparisonLines
        ? sorted.reduce((sum, row) => sum + (row.comparisonAmountCents ?? 0), 0)
        : null
      return {
        key,
        label:
          key === UNCODED_KEY
            ? "Uncoded"
            : labels.get(key) ?? `Division ${key}`,
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

  return {
    divisions,
    amountCents,
    comparisonAmountCents: comparisonLines ? rows.reduce((sum, row) => sum + (row.comparisonAmountCents ?? 0), 0) : null,
    deltaCents: comparisonLines
      ? amountCents - rows.reduce((sum, row) => sum + (row.comparisonAmountCents ?? 0), 0)
      : null,
    lineCount: rows.filter((row) => row.status !== "removed").length,
    unpricedCount: rows.filter((row) => row.unpriced).length,
    changedCount: rows.filter((row) => row.status !== "same").length,
  }
}
