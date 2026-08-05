/**
 * Whether a caller's authentication is strong enough, and recent enough, to
 * release money.
 *
 * Pure and transport-free on purpose. The web app reads assurance from a
 * cookie-bound Supabase session and the mobile app reads the same facts from
 * its bearer token's claims — different transports carrying identical data. The
 * decision must not differ between them, so the decision lives here and each
 * transport only supplies the facts.
 */

export const PAYMENT_STEP_UP_MAX_AGE_SECONDS = 10 * 60

export interface AuthenticationMethodFact {
  method?: string | null
  /** Unix seconds. */
  timestamp?: number | null
}

/**
 * Methods that do not count as a second factor, however recently they happened.
 *
 * `otp` is here deliberately: in Supabase's vocabulary it means an emailed
 * magic-link code, which is a primary factor, not a step-up. Treating it as one
 * would let an attacker with mailbox access approve payments.
 */
const PRIMARY_FACTOR_METHODS = new Set(["password", "oauth", "magiclink", "otp"])

export interface StepUpDecision {
  satisfied: boolean
  /** ISO timestamp of the second factor, when one satisfied the policy. */
  verifiedAt: string | null
  reason: "ok" | "not_aal2" | "no_second_factor" | "expired"
  message: string
}

export function evaluatePaymentStepUp(input: {
  assuranceLevel: string | null | undefined
  methods: readonly AuthenticationMethodFact[]
  nowSeconds?: number
}): StepUpDecision {
  if (input.assuranceLevel !== "aal2") {
    return {
      satisfied: false,
      verifiedAt: null,
      reason: "not_aal2",
      message: "Two-factor authentication is required for payment approval",
    }
  }
  const secondFactor = input.methods
    .filter((method) => method.method && !PRIMARY_FACTOR_METHODS.has(method.method))
    .sort((left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0))[0]
  if (!secondFactor?.timestamp) {
    return {
      satisfied: false,
      verifiedAt: null,
      reason: "no_second_factor",
      message: "Complete a new two-factor challenge before approving this payment",
    }
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const ageSeconds = nowSeconds - secondFactor.timestamp
  // A negative age means a timestamp in the future — clock skew, or a forged
  // claim. Either way it is not evidence that someone authenticated recently.
  if (ageSeconds < 0 || ageSeconds > PAYMENT_STEP_UP_MAX_AGE_SECONDS) {
    return {
      satisfied: false,
      verifiedAt: null,
      reason: "expired",
      message: "Your payment approval verification expired. Complete two-factor authentication again.",
    }
  }
  return {
    satisfied: true,
    verifiedAt: new Date(secondFactor.timestamp * 1000).toISOString(),
    reason: "ok",
    message: "ok",
  }
}
