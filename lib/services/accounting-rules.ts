import type { AccountingDimensionKind, AccountingDimensionValue, AccountingTarget } from "@/lib/integrations/accounting/provider"
import type { AccountingCoding } from "@/lib/services/accounting-coding"

export type AccountingMapCandidate = {
  id: string
  connection_id: string
  scope: AccountingTarget["resolvedFrom"]
  dimensions: Partial<Record<AccountingDimensionKind, AccountingDimensionValue>> | null
}

const PRECEDENCE: AccountingTarget["resolvedFrom"][] = ["project", "community", "division", "org_default"]

export function selectAccountingMap(rows: AccountingMapCandidate[]) {
  const winner = PRECEDENCE.map((scope) => rows.find((row) => row.scope === scope)).find(Boolean)
  if (!winner) return null
  const dimensions = PRECEDENCE.slice()
    .reverse()
    .map((scope) => rows.find((row) => row.scope === scope && row.connection_id === winner.connection_id)?.dimensions ?? {})
    .reduce<Partial<Record<AccountingDimensionKind, AccountingDimensionValue>>>((merged, item) => ({ ...merged, ...item }), {})
  return { winner, dimensions }
}

export function accountingPushBlockReason(input: {
  hasTarget: boolean
  healthy: boolean
  pushable?: boolean | null
  existingConnectionId?: string | null
  targetConnectionId?: string | null
  enabled: boolean
}) {
  if (!input.hasTarget) return "unconnected" as const
  if (!input.healthy) return "connection_unhealthy" as const
  if (input.pushable === false) return "inbound_only" as const
  if (input.existingConnectionId && input.targetConnectionId && input.existingConnectionId !== input.targetConnectionId) return "connection_mismatch" as const
  if (!input.enabled) return "disabled" as const
  return null
}

export type CodingRuleCandidate = {
  id: string
  company_id: string | null
  match_kind: "vendor" | "vendor_memo"
  match_value: string
  memo_pattern: string | null
  cost_code_id: string | null
  budget_line_id: string | null
  /** The rule's coding payload; may carry a `line_splits` split pattern (see below). */
  accounting_coding: AccountingCoding & { line_splits?: unknown }
  confidence: number
  hit_count: number
  correction_count: number
  last_corrected_at: string | null
}

/**
 * One leg of a learned split pattern. Weights are basis points of the bill
 * total (10000 = the whole bill) so a remembered 70/30 re-applies to any
 * amount without floating-point money math.
 */
export type CodingLineSplit = {
  costCodeId: string | null
  budgetLineId: string | null
  weightBp: number
  description: string | null
}

export type CodingSuggestion = {
  ruleId: string
  costCodeId: string | null
  budgetLineId: string | null
  accountingCoding: AccountingCoding
  confidence: number
  autoApply: boolean
  reason: "vendor_memo" | "vendor"
  /** Multi-line split remembered for this vendor, when one was learned. */
  lineSplits: CodingLineSplit[] | null
}

/**
 * Split patterns ride inside the rule's `accounting_coding` JSON under this
 * key (the table has no metadata column, and adding one is a migration). The
 * key is stripped before the coding is handed back so it never leaks onto a
 * bill's own `accounting_coding`.
 */
const LINE_SPLITS_KEY = "line_splits"

function parseLineSplits(coding: { line_splits?: unknown }): CodingLineSplit[] | null {
  const raw = coding[LINE_SPLITS_KEY]
  if (!Array.isArray(raw) || raw.length < 2) return null
  const splits: CodingLineSplit[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null
    const record = entry as Record<string, unknown>
    const weightBp = record.weight_bp
    if (typeof weightBp !== "number" || !Number.isInteger(weightBp) || weightBp <= 0) return null
    splits.push({
      costCodeId: typeof record.cost_code_id === "string" ? record.cost_code_id : null,
      budgetLineId: typeof record.budget_line_id === "string" ? record.budget_line_id : null,
      weightBp,
      description: typeof record.description === "string" ? record.description : null,
    })
  }
  const totalBp = splits.reduce((sum, split) => sum + split.weightBp, 0)
  return totalBp === 10_000 ? splits : null
}

/** Serialize a split pattern into the shape `parseLineSplits` reads back. */
export function encodeLineSplits(splits: CodingLineSplit[]): Array<Record<string, unknown>> {
  return splits.map((split) => ({
    cost_code_id: split.costCodeId,
    budget_line_id: split.budgetLineId,
    weight_bp: split.weightBp,
    description: split.description,
  }))
}

/**
 * Pro-rate a learned split across a bill total: integer cents throughout, with
 * the rounding remainder carried by the last line so the legs always sum to
 * the bill exactly.
 */
export function allocateSplitAmounts(splits: CodingLineSplit[], totalCents: number): number[] {
  let allocated = 0
  return splits.map((split, index) => {
    if (index === splits.length - 1) return totalCents - allocated
    const amount = Math.round((split.weightBp / 10_000) * totalCents)
    allocated += amount
    return amount
  })
}

function normalizeCodingRuleValue(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? ""
}

function wasRecentlyCorrected(value: string | null, days: number, now = new Date()) {
  if (!value) return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  return now.getTime() - parsed.getTime() <= days * 24 * 60 * 60 * 1000
}

/** Clean confirmations a rule must earn before it codes a bill without review. */
export const CODING_RULE_AUTO_APPLY_HITS = 3

/** How long a correction suppresses auto-apply, regardless of hits since. */
export const CODING_RULE_COOLDOWN_DAYS = 90

/**
 * What a rule's counters become after one more bill passes through it.
 *
 * A correction **demotes** the rule: the hit streak resets, so it must re-earn
 * its confirmations before auto-applying again. That, plus the cooldown window
 * in `selectCodingSuggestion`, is the recovery path — the old rule required
 * `correction_count === 0` forever, which meant a single correction retired a
 * rule permanently and the 90-day window it was paired with could never be
 * reached. Rules decayed to zero org-wide and the engine quietly stopped
 * working.
 *
 * `correction_count` is kept as a lifetime counter: it no longer gates
 * auto-apply, it damps confidence, so a chronically wrong rule stays visibly
 * low-confidence even while its current streak looks clean.
 */
export function nextCodingRuleCounts(input: {
  hitCount: number
  correctionCount: number
  corrected: boolean
}): { hitCount: number; correctionCount: number; confidence: number } {
  const hitCount = input.corrected ? 0 : Math.max(0, input.hitCount) + 1
  const correctionCount = Math.max(0, input.correctionCount) + (input.corrected ? 1 : 0)
  const confidence = Math.max(0, Math.min(1, hitCount / Math.max(3, hitCount + correctionCount * 2)))
  return { hitCount, correctionCount, confidence }
}

/**
 * Did the person actually disagree with the rule, or just save the bill?
 *
 * Treating every edit of a rule-coded bill as a contradiction is what made
 * corrections outnumber hits: opening a payable, changing the due date, and
 * saving used to demote the rule that had coded it correctly. A correction is a
 * coding value that ends up different from the one the rule proposed — nothing
 * else.
 *
 * `applied` is null when no rule coded this bill, which is a fresh lesson
 * rather than a correction.
 */
export function isCodingCorrection(input: {
  applied: { costCodeId: string | null; budgetLineId: string | null } | null
  final: { costCodeId: string | null; budgetLineId: string | null }
}): boolean {
  if (!input.applied) return false
  return (
    (input.applied.costCodeId ?? null) !== (input.final.costCodeId ?? null) ||
    (input.applied.budgetLineId ?? null) !== (input.final.budgetLineId ?? null)
  )
}

/** Canonical, provider-neutral learned-coding selector used by every accounting rail. */
export function selectCodingSuggestion(input: {
  rules: CodingRuleCandidate[]
  companyId?: string | null
  vendorName?: string | null
  memo?: string | null
  now?: Date
}): CodingSuggestion | null {
  const vendorValue = normalizeCodingRuleValue(input.vendorName)
  const memoValue = normalizeCodingRuleValue(input.memo)
  const candidates = input.rules.filter((rule) => {
    const vendorMatches = input.companyId ? rule.company_id === input.companyId : rule.company_id === null && rule.match_value === vendorValue
    if (!vendorMatches) return false
    if (rule.match_kind === "vendor") return true
    return rule.match_kind === "vendor_memo" && Boolean(rule.memo_pattern) && memoValue.includes(normalizeCodingRuleValue(rule.memo_pattern))
  })
  candidates.sort((left, right) => {
    const kindDifference = Number(right.match_kind === "vendor_memo") - Number(left.match_kind === "vendor_memo")
    if (kindDifference !== 0) return kindDifference
    if (right.hit_count !== left.hit_count) return right.hit_count - left.hit_count
    return right.confidence - left.confidence
  })
  const winner = candidates[0]
  if (!winner) return null
  const { line_splits, ...cleanCoding } = winner.accounting_coding
  void line_splits
  return {
    ruleId: winner.id,
    costCodeId: winner.cost_code_id,
    budgetLineId: winner.budget_line_id,
    accountingCoding: cleanCoding,
    confidence: winner.confidence,
    // The hit streak resets on correction (`nextCodingRuleCounts`), so this is
    // "three clean confirmations since the last disagreement" — not "never
    // corrected in its life", which retired rules permanently.
    autoApply:
      winner.hit_count >= CODING_RULE_AUTO_APPLY_HITS &&
      !wasRecentlyCorrected(winner.last_corrected_at, CODING_RULE_COOLDOWN_DAYS, input.now),
    reason: winner.match_kind === "vendor_memo" ? "vendor_memo" : "vendor",
    lineSplits: parseLineSplits(winner.accounting_coding),
  }
}
