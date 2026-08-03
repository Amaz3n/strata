import type { PaymentHoldKind, PaymentHoldLevel } from "@/lib/validation/payment-holds"

/**
 * Pure AP payment-hold policy. Kept free of server imports so the release gate
 * that decides whether money moves can be tested directly.
 */

export interface PaymentHold {
  kind: PaymentHoldKind
  level: PaymentHoldLevel
  message: string
  cureHref: string | null
  overridden: boolean
  overrideReason: string | null
}

export interface PaymentHoldFacts {
  projectId: string
  companyId: string | null
  complianceCurrent: boolean
  insuranceCurrent: boolean
  /**
   * Whether org compliance rules or the project's sub-tier rule actually ask for
   * a waiver on this bill. `assertBillReleasable` gates its hard waiver checks on
   * the same flags — when this is false there is no document to chase and no
   * hold to raise.
   */
  waiverRequired: boolean
  waiverSigned: boolean
  retainageRulesMet: boolean
  fundingRequired: boolean
  fundingReceived: boolean
  overrides: Partial<Record<PaymentHoldKind, string>>
  policy: Partial<Record<PaymentHoldKind, PaymentHoldLevel>>
}

export interface PaymentHoldEvaluation {
  holds: PaymentHold[]
  releasable: boolean
  warningCount: number
  blockingCount: number
}

export const DEFAULT_PAYMENT_HOLD_POLICY: Record<PaymentHoldKind, PaymentHoldLevel> = {
  insurance_current: "block",
  waiver_signed: "block",
  compliance_docs_approved: "block",
  retainage_rules_met: "warn",
  funding_received: "warn",
}

const HOLD_MESSAGES: Record<PaymentHoldKind, string> = {
  insurance_current: "Vendor insurance is missing, expired, or awaiting approval",
  waiver_signed: "A signed lien waiver is required before payment",
  compliance_docs_approved: "Required compliance documents are incomplete",
  retainage_rules_met: "Retainage release conditions have not been met",
  funding_received: "The linked owner invoice has not been paid",
}

export function evaluatePaymentHoldFacts(facts: PaymentHoldFacts): PaymentHoldEvaluation {
  const active: Array<{ kind: PaymentHoldKind; failed: boolean; cureHref: string | null }> = [
    { kind: "insurance_current", failed: !facts.insuranceCurrent, cureHref: facts.companyId ? `/companies/${facts.companyId}?tab=compliance` : null },
    { kind: "waiver_signed", failed: facts.waiverRequired && !facts.waiverSigned, cureHref: `/projects/${facts.projectId}/financials/payables` },
    { kind: "compliance_docs_approved", failed: !facts.complianceCurrent, cureHref: facts.companyId ? `/companies/${facts.companyId}?tab=compliance` : null },
    { kind: "retainage_rules_met", failed: !facts.retainageRulesMet, cureHref: `/projects/${facts.projectId}/financials/payables` },
    { kind: "funding_received", failed: facts.fundingRequired && !facts.fundingReceived, cureHref: `/projects/${facts.projectId}/financials/receivables` },
  ]
  const holds = active.filter((item) => item.failed).map((item) => {
    const overrideReason = facts.overrides[item.kind] ?? null
    return {
      kind: item.kind,
      level: facts.policy[item.kind] ?? DEFAULT_PAYMENT_HOLD_POLICY[item.kind],
      message: HOLD_MESSAGES[item.kind],
      cureHref: item.cureHref,
      overridden: overrideReason !== null,
      overrideReason,
    }
  })
  const blockingCount = holds.filter((hold) => hold.level === "block" && !hold.overridden).length
  return { holds, releasable: blockingCount === 0, warningCount: holds.filter((hold) => hold.level === "warn" && !hold.overridden).length, blockingCount }
}

export function parsePaymentHoldPolicy(value: unknown): Partial<Record<PaymentHoldKind, PaymentHoldLevel>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PAYMENT_HOLD_POLICY
  const result: Partial<Record<PaymentHoldKind, PaymentHoldLevel>> = {}
  for (const kind of Object.keys(DEFAULT_PAYMENT_HOLD_POLICY) as PaymentHoldKind[]) {
    const level = (value as Record<string, unknown>)[kind]
    if (level === "block" || level === "warn") result[kind] = level
  }
  return { ...DEFAULT_PAYMENT_HOLD_POLICY, ...result }
}
