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
  match_kind: "vendor" | "vendor_memo" | "card_scope" | "email_sender"
  match_value: string
  memo_pattern: string | null
  cost_code_id: string | null
  budget_line_id: string | null
  accounting_coding: AccountingCoding
  confidence: number
  hit_count: number
  correction_count: number
  last_corrected_at: string | null
}

export type CodingSuggestion = {
  ruleId: string
  costCodeId: string | null
  budgetLineId: string | null
  accountingCoding: AccountingCoding
  confidence: number
  autoApply: boolean
  reason: "vendor_memo" | "vendor"
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
  return {
    ruleId: winner.id,
    costCodeId: winner.cost_code_id,
    budgetLineId: winner.budget_line_id,
    accountingCoding: winner.accounting_coding,
    confidence: winner.confidence,
    autoApply: winner.hit_count >= 3 && winner.correction_count === 0 && !wasRecentlyCorrected(winner.last_corrected_at, 90, input.now),
    reason: winner.match_kind === "vendor_memo" ? "vendor_memo" : "vendor",
  }
}
