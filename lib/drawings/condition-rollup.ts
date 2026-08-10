/**
 * The rollup arithmetic: measured geometry → the number that gets priced.
 *
 * Split out of `lib/services/takeoff.ts` because this is where money is decided
 * and it should be checkable without a database. Everything here is pure — the
 * service loads the rows, this decides what they add up to, and the two are
 * tested separately.
 *
 * The classification rules are the whole point, and each one exists because the
 * alternative is a quantity that lies:
 *
 *   - a member on a SUPERSEDED sheet version is excluded. A measurement taken on
 *     Rev 2 is not evidence about Rev 3.
 *   - a member CARRIED FORWARD by a revision and not yet confirmed is excluded.
 *     It is a question, not a quantity (docs/takeoff-reanchor-design.md).
 *   - a member on an UNCALIBRATED sheet has no quantity at all, and is counted
 *     as such rather than as zero.
 *   - a DEDUCTION subtracts, and a condition whose deductions win is clamped to
 *     zero and flagged, because a negative estimate line is never an intent.
 */

import {
  applyWaste,
  conditionSourceUom,
  conversionSummary,
  convertToConditionUom,
  extendedCents,
  QUANTITY_EPSILON,
  type ConditionFactors,
  type ConditionUom,
  type MeasureUom,
} from "@/lib/drawings/measure"

/** Per-condition sheet breakdown cap. Beyond this the panel says "+N more". */
export const CONDITION_SHEET_BREAKDOWN_CAP = 12

export interface RollupMember {
  id: string
  condition_id: string
  /** Null when the sheet has no scale yet. */
  quantity: number | null
  drawing_sheet_id: string
  sheet_number: string
  sheet_title: string | null
  is_current_version: boolean
  pending_review: boolean
  is_deduction: boolean
}

export interface RollupCondition extends ConditionFactors {
  id: string
  name: string
  uom: ConditionUom
  waste_pct: number
  unit_cost_cents: number | null
  cost_code_id: string | null
}

export interface RollupCostCode {
  id: string
  code: string
  name: string
  unit: string | null
  default_unit_cost_cents: number | null
}

export interface ConditionSheetBreakdown {
  drawing_sheet_id: string
  sheet_number: string
  sheet_title: string | null
  quantity: number
  markup_count: number
  deduction_count: number
}

export interface ConditionTotals {
  source_quantity: number
  source_uom: MeasureUom
  conversion_summary: string | null
  measured_quantity: number
  effective_quantity: number
  markup_count: number
  deduction_count: number
  net_negative: boolean
  stale_markup_count: number
  unscaled_markup_count: number
  pending_review_count: number
  cost_code: { id: string; code: string; name: string; unit: string | null } | null
  effective_unit_cost_cents: number | null
  rate_source: "pinned" | "cost_code" | null
  extended_cents: number | null
  sheets: ConditionSheetBreakdown[]
  sheets_truncated: number
  duplicate_suspect_sheets: string[]
}

/** Two decimals, matching what is written to an estimate line. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Everything one condition adds up to.
 *
 * Conversion is applied PER MEMBER rather than to the sum. Every conversion is a
 * linear multiplier so the total is identical either way, but doing it per
 * member is what lets the per-sheet breakdown be reported in the condition's
 * unit without drifting from the total the estimator is looking at.
 */
export function rollUpCondition(
  condition: RollupCondition,
  members: RollupMember[],
  costCode: RollupCostCode | null,
): ConditionTotals {
  const onCurrentVersion = members.filter((member) => member.is_current_version)
  const current = onCurrentVersion.filter((member) => !member.pending_review)
  const pendingReview = onCurrentVersion.length - current.length
  const stale = members.length - onCurrentVersion.length
  const unscaled = current.filter((member) => member.quantity === null).length
  const deductions = current.filter((member) => member.is_deduction).length

  const sourceQuantity = current.reduce((sum, member) => sum + (member.quantity ?? 0), 0)
  const converted = current.reduce(
    (sum, member) => sum + convertToConditionUom(member.quantity ?? 0, condition.uom, condition),
    0,
  )

  const netNegative = converted < -QUANTITY_EPSILON
  const measured = netNegative ? 0 : converted
  const effective = applyWaste(measured, condition.waste_pct)

  const pinned = condition.unit_cost_cents
  const fallback = costCode?.default_unit_cost_cents ?? null
  const rate = pinned ?? fallback ?? null

  const sheets = buildSheetBreakdown(current, condition)

  return {
    source_quantity: round2(sourceQuantity),
    source_uom: conditionSourceUom(condition.uom, condition),
    conversion_summary: conversionSummary(sourceQuantity, condition.uom, condition),
    measured_quantity: round2(measured),
    effective_quantity: effective,
    markup_count: current.length,
    deduction_count: deductions,
    net_negative: netNegative,
    stale_markup_count: stale,
    unscaled_markup_count: unscaled,
    pending_review_count: pendingReview,
    cost_code: costCode
      ? { id: costCode.id, code: costCode.code, name: costCode.name, unit: costCode.unit ?? null }
      : null,
    effective_unit_cost_cents: rate,
    rate_source: pinned != null ? "pinned" : fallback != null ? "cost_code" : null,
    extended_cents: rate != null ? extendedCents(effective, rate) : null,
    sheets: sheets.slice(0, CONDITION_SHEET_BREAKDOWN_CAP),
    sheets_truncated: Math.max(0, sheets.length - CONDITION_SHEET_BREAKDOWN_CAP),
    duplicate_suspect_sheets: findDuplicateSuspects(sheets),
  }
}

export function buildSheetBreakdown(
  members: RollupMember[],
  condition: RollupCondition,
): ConditionSheetBreakdown[] {
  const bySheet = new Map<string, ConditionSheetBreakdown>()
  for (const member of members) {
    const quantity = convertToConditionUom(member.quantity ?? 0, condition.uom, condition)
    const existing = bySheet.get(member.drawing_sheet_id)
    if (existing) {
      existing.quantity += quantity
      existing.markup_count += 1
      if (member.is_deduction) existing.deduction_count += 1
    } else {
      bySheet.set(member.drawing_sheet_id, {
        drawing_sheet_id: member.drawing_sheet_id,
        sheet_number: member.sheet_number,
        sheet_title: member.sheet_title,
        quantity,
        markup_count: 1,
        deduction_count: member.is_deduction ? 1 : 0,
      })
    }
  }
  return Array.from(bySheet.values())
    .map((sheet) => ({ ...sheet, quantity: round2(sheet.quantity) }))
    .sort((a, b) => b.quantity - a.quantity || a.sheet_number.localeCompare(b.sheet_number))
}

/**
 * Two sheets within this of each other are suspiciously alike. Loose enough to
 * catch a floor traced twice by hand (two passes never match exactly), tight
 * enough that two genuinely different rooms rarely collide.
 */
const DUPLICATE_SHEET_TOLERANCE = 0.02

/**
 * The same plan appears on the dimension sheet, the finish sheet, and the
 * electrical sheet. Measuring flooring on two of them double-counts it, the
 * total still looks plausible, and nothing in a summed number gives it away.
 * Near-equal per-sheet contributions are the one signal that does.
 */
export function findDuplicateSuspects(sheets: ConditionSheetBreakdown[]): string[] {
  if (sheets.length < 2) return []
  const suspects = new Set<string>()
  for (let i = 0; i < sheets.length; i++) {
    for (let j = i + 1; j < sheets.length; j++) {
      const a = sheets[i].quantity
      const b = sheets[j].quantity
      if (a <= 0 || b <= 0) continue
      if (Math.abs(a - b) / Math.max(a, b) > DUPLICATE_SHEET_TOLERANCE) continue
      suspects.add(sheets[i].sheet_number)
      suspects.add(sheets[j].sheet_number)
    }
  }
  return Array.from(suspects).sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------------------
// Sync classification
// ---------------------------------------------------------------------------

export type SyncAction = "create" | "update" | "unchanged" | "drift"

/**
 * What a sync would do to one destination line.
 *
 * `drift` is the important one: the line's live quantity no longer matches what
 * the last sync wrote, which means a human typed over it. Overwriting that
 * without being told to is the single failure mode an estimator will never
 * forgive, so it is a distinct outcome rather than just another update.
 */
export function classifySyncRow(input: {
  nextQuantity: number
  liveQuantity: number | null
  lastSyncedQuantity: number | null
}): SyncAction {
  if (input.liveQuantity === null) return "create"

  const lastSynced = input.lastSyncedQuantity ?? 0
  if (Math.abs(input.liveQuantity - lastSynced) > QUANTITY_EPSILON) return "drift"

  return Math.abs(input.liveQuantity - input.nextQuantity) > QUANTITY_EPSILON
    ? "update"
    : "unchanged"
}
