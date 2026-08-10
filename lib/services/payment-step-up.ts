import "server-only"

import { evaluatePaymentStepUp, type AuthenticationMethodFact } from "@/lib/payments/step-up-policy"
import { createServerSupabaseClient } from "@/lib/supabase/server"

/**
 * Assurance is a property of the caller's SESSION, so this resolves the
 * cookie-bound client itself rather than accepting one. `requireOrgMembership`
 * hands platform admins a service-role client, which carries no session — passing
 * that in made the check unsatisfiable and locked real approvers out.
 *
 * The decision itself lives in `evaluatePaymentStepUp` so the mobile path, which
 * reads the same facts off a bearer token instead of a cookie, cannot drift into
 * a weaker rule.
 */
export async function requireRecentPaymentStepUp() {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error) throw new Error("Two-factor authentication is required for payment approval")
  const methods: AuthenticationMethodFact[] = (data?.currentAuthenticationMethods ?? []).flatMap((method) =>
    typeof method === "string" ? [] : [{ method: method.method ?? null, timestamp: method.timestamp ?? null }],
  )
  const decision = evaluatePaymentStepUp({ assuranceLevel: data?.currentLevel, methods })
  if (!decision.satisfied || !decision.verifiedAt) throw new Error(decision.message)
  return decision.verifiedAt
}

/**
 * The same policy, read from a bearer token's claims.
 *
 * Mobile has no cookie session, so `auth.mfa` is unavailable — but the access
 * token carries the identical `aal` and `amr` claims the session exposes.
 * Decoding them without verification would be a hole; this is only ever called
 * after `requireMobileUser` has had Supabase validate the token, so the claims
 * are authentic by then.
 */
export function requireRecentMobilePaymentStepUp(accessToken: string) {
  const payload = decodeJwtPayload(accessToken)
  const amr = Array.isArray(payload?.amr) ? payload.amr : []
  const methods: AuthenticationMethodFact[] = amr.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const method = Reflect.get(entry, "method")
    const timestamp = Reflect.get(entry, "timestamp")
    return [{
      method: typeof method === "string" ? method : null,
      timestamp: typeof timestamp === "number" ? timestamp : null,
    }]
  })
  const decision = evaluatePaymentStepUp({
    assuranceLevel: typeof payload?.aal === "string" ? payload.aal : null,
    methods,
  })
  if (!decision.satisfied || !decision.verifiedAt) throw new Error(decision.message)
  return decision.verifiedAt
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".")
  if (segments.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}
