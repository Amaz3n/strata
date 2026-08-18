import type { PaymentHoldKind, PaymentHoldLevel } from "@/lib/validation/payment-holds"

/**
 * Pure AP payment-hold policy. Kept free of server imports so the release gate
 * that decides whether money moves can be tested directly.
 */

export interface PaymentHold {
  kind: PaymentHoldKind
  level: PaymentHoldLevel
  message: string
  /** Extra evidence for the human — e.g. the waiver-verification mismatch list. */
  detail: string | null
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
   * Where a confident reading of the certificate disagrees with the compliance
   * record, in either direction. Raises the warn-only `insurance_verified` hold;
   * it never moves `insuranceCurrent`, which is the blocking fact.
   */
  insuranceContradiction?: string | null
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
  /**
   * AI/deterministic verification of the signed waiver document against the
   * bill's expected facts. Absent (or null) means "not verified yet", which
   * raises no hold — verification is a checkable claim, never a prerequisite.
   */
  waiverVerification?: {
    matches: boolean
    mismatchSummary: string | null
    documentHref: string | null
  } | null
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
  // Verification is an AI-produced claim routed to a human: it can only ever
  // warn by default, and absence of verification raises nothing at all.
  insurance_verified: "warn",
  waiver_signed: "block",
  waiver_verified: "warn",
  compliance_docs_approved: "block",
  retainage_rules_met: "warn",
  funding_received: "warn",
}

const HOLD_MESSAGES: Record<PaymentHoldKind, string> = {
  insurance_current: "Vendor insurance is missing, expired, or awaiting approval",
  insurance_verified: "The scanned certificate of insurance does not match the compliance record",
  waiver_signed: "A signed lien waiver is required before payment",
  waiver_verified: "The signed lien waiver does not match this payable",
  compliance_docs_approved: "Required compliance documents are incomplete",
  retainage_rules_met: "Retainage release conditions have not been met",
  funding_received: "The linked owner invoice has not been paid",
}

/**
 * Holds whose evidence comes from reading a document rather than from a record
 * a human maintained. These can only ever warn: a model must be able to raise
 * its hand, never to stop a subcontractor being paid.
 */
const AI_CLAIM_HOLD_KINDS = new Set<PaymentHoldKind>(["waiver_verified", "insurance_verified"])

export function evaluatePaymentHoldFacts(facts: PaymentHoldFacts): PaymentHoldEvaluation {
  const waiverVerification = facts.waiverVerification ?? null
  const active: Array<{ kind: PaymentHoldKind; failed: boolean; cureHref: string | null; detail: string | null }> = [
    { kind: "insurance_current", failed: !facts.insuranceCurrent, cureHref: facts.companyId ? `/directory/${facts.companyId}/compliance` : null, detail: facts.insuranceContradiction ?? null },
    {
      kind: "insurance_verified",
      failed: Boolean(facts.insuranceContradiction),
      cureHref: facts.companyId ? `/directory/${facts.companyId}/compliance` : null,
      detail: facts.insuranceContradiction ?? null,
    },
    { kind: "waiver_signed", failed: facts.waiverRequired && !facts.waiverSigned, cureHref: `/projects/${facts.projectId}/financials/payables`, detail: null },
    {
      kind: "waiver_verified",
      failed: waiverVerification !== null && !waiverVerification.matches,
      cureHref: waiverVerification?.documentHref ?? `/projects/${facts.projectId}/financials/payables`,
      detail: waiverVerification?.mismatchSummary ?? null,
    },
    { kind: "compliance_docs_approved", failed: !facts.complianceCurrent, cureHref: facts.companyId ? `/directory/${facts.companyId}/compliance` : null, detail: null },
    { kind: "retainage_rules_met", failed: !facts.retainageRulesMet, cureHref: `/projects/${facts.projectId}/financials/payables`, detail: null },
    { kind: "funding_received", failed: facts.fundingRequired && !facts.fundingReceived, cureHref: `/projects/${facts.projectId}/financials/receivables`, detail: null },
  ]
  const holds = active.filter((item) => item.failed).map((item) => {
    const overrideReason = facts.overrides[item.kind] ?? null
    return {
      kind: item.kind,
      // An AI-verified mismatch is a claim for a human to check, so it is
      // clamped to warn — no policy configuration may turn it into a block.
      level: AI_CLAIM_HOLD_KINDS.has(item.kind) ? "warn" : facts.policy[item.kind] ?? DEFAULT_PAYMENT_HOLD_POLICY[item.kind],
      message: HOLD_MESSAGES[item.kind],
      detail: item.detail,
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
