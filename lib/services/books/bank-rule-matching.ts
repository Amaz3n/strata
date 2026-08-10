import { CODING_RULE_AUTO_APPLY_HITS } from "@/lib/services/accounting-rules"

/**
 * Which learned rule categorizes this bank transaction.
 *
 * Pure, and it reuses B1's confidence curve rather than inventing a second one:
 * `nextCodingRuleCounts` and `CODING_RULE_AUTO_APPLY_HITS` govern payables coding
 * and bank rules alike, so a rule earns trust the same way on both rails. What is
 * NOT shared is the table — a coding rule keys on a company and targets a cost
 * code; a bank rule keys on free text a bank wrote and targets a GL account.
 * See `20260808180000_books_bank_rules.sql` for that reasoning.
 */

export type BankRuleCandidate = {
  id: string
  matchKind: "merchant_exact" | "description_contains"
  matchValue: string
  direction: "inflow" | "outflow" | null
  bankAccountId: string | null
  glAccountId: string
  projectId: string | null
  costCodeId: string | null
  confidence: number
  hitCount: number
  active: boolean
}

export type BankRuleSuggestion = {
  ruleId: string
  glAccountId: string
  projectId: string | null
  costCodeId: string | null
  confidence: number
  /** True once the rule has earned enough clean confirmations to apply unread. */
  autoApplies: boolean
}

/** Case and surrounding whitespace are noise; banks are inconsistent about both. */
export function normalizeBankRuleValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * The best rule for one transaction, or null.
 *
 * Specificity wins over popularity, in this order:
 *   1. `merchant_exact` over `description_contains` — the provider's normalized
 *      merchant is a stronger signal than a substring someone chose.
 *   2. A rule bound to this bank account over one that applies to every account.
 *   3. A rule bound to this direction over one that applies to both.
 *   4. Then the longer match value, then confidence — a longer substring is a
 *      narrower claim, so "home depot pro" should beat "home depot".
 */
export function selectBankRule(input: {
  transaction: {
    bankAccountId: string
    direction: "inflow" | "outflow"
    merchantName?: string | null
    description?: string | null
  }
  rules: BankRuleCandidate[]
}): BankRuleSuggestion | null {
  const merchant = normalizeBankRuleValue(input.transaction.merchantName)
  const description = normalizeBankRuleValue(input.transaction.description)

  const matches = input.rules.filter((rule) => {
    if (!rule.active) return false
    if (rule.bankAccountId && rule.bankAccountId !== input.transaction.bankAccountId) return false
    if (rule.direction && rule.direction !== input.transaction.direction) return false
    const value = normalizeBankRuleValue(rule.matchValue)
    if (!value) return false
    if (rule.matchKind === "merchant_exact") return Boolean(merchant) && merchant === value
    // A description rule may also match the merchant, since providers put the
    // payee in either field depending on the institution.
    return description.includes(value) || (Boolean(merchant) && merchant.includes(value))
  })

  matches.sort((left, right) => {
    const byKind = Number(right.matchKind === "merchant_exact") - Number(left.matchKind === "merchant_exact")
    if (byKind !== 0) return byKind
    const byAccount = Number(Boolean(right.bankAccountId)) - Number(Boolean(left.bankAccountId))
    if (byAccount !== 0) return byAccount
    const byDirection = Number(Boolean(right.direction)) - Number(Boolean(left.direction))
    if (byDirection !== 0) return byDirection
    const byLength = right.matchValue.length - left.matchValue.length
    if (byLength !== 0) return byLength
    return right.confidence - left.confidence
  })

  const winner = matches[0]
  if (!winner) return null
  return {
    ruleId: winner.id,
    glAccountId: winner.glAccountId,
    projectId: winner.projectId,
    costCodeId: winner.costCodeId,
    confidence: winner.confidence,
    autoApplies: winner.hitCount >= CODING_RULE_AUTO_APPLY_HITS,
  }
}

/**
 * What rule a categorization should teach.
 *
 * Prefers the provider's merchant, because it is already normalized and stable
 * across statements. Falls back to the raw description, which is noisier — bank
 * descriptions carry dates, terminal ids and trace numbers — so it is only worth
 * learning when there is a merchant-free description to key on.
 */
export function buildBankRuleLesson(input: {
  merchantName?: string | null
  description?: string | null
}): { matchKind: "merchant_exact" | "description_contains"; matchValue: string } | null {
  const merchant = normalizeBankRuleValue(input.merchantName)
  if (merchant) return { matchKind: "merchant_exact", matchValue: merchant }
  const description = normalizeBankRuleValue(input.description)
  // Too short to be a payee — matching on it would categorize half the feed.
  if (description.length < 4) return null
  return { matchKind: "description_contains", matchValue: description }
}

/** Did the person put this transaction somewhere other than where the rule said? */
export function isBankRuleCorrection(input: {
  applied: { glAccountId: string } | null
  final: { glAccountId: string }
}): boolean {
  if (!input.applied) return false
  return input.applied.glAccountId !== input.final.glAccountId
}
