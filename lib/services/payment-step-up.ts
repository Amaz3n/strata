import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

const PAYMENT_STEP_UP_MAX_AGE_SECONDS = 10 * 60

export async function requireRecentPaymentStepUp(supabase: SupabaseClient) {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || data?.currentLevel !== "aal2") {
    throw new Error("Two-factor authentication is required for payment approval")
  }
  const methods = data.currentAuthenticationMethods ?? []
  const secondFactor = methods
    .filter((method) => typeof method !== "string")
    .filter((method) => method.method && !["password", "oauth", "magiclink", "otp"].includes(method.method))
    .sort((left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0))[0]
  if (!secondFactor?.timestamp) throw new Error("Complete a new two-factor challenge before approving this payment")
  const ageSeconds = Math.floor(Date.now() / 1000) - secondFactor.timestamp
  if (ageSeconds < 0 || ageSeconds > PAYMENT_STEP_UP_MAX_AGE_SECONDS) {
    throw new Error("Your payment approval verification expired. Complete two-factor authentication again.")
  }
  return new Date(secondFactor.timestamp * 1000).toISOString()
}
