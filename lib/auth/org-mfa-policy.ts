/**
 * The organization "require two-factor" rule, as one decision.
 *
 * Web reads assurance from the Auth server's verdict on the session and mobile
 * reads it off the bearer token's claims; both ask this module so a policy set
 * once cannot be satisfied differently on each transport. A session is
 * compliant only at `aal2` - a member who has enrolled a factor but not
 * completed the challenge is routed to the challenge by the existing step-up
 * gate, and one with no factor at all is routed to enrollment.
 */

export const ORG_MFA_REQUIRED_MESSAGE =
  "Your organization requires two-factor authentication. Set it up in Arc on the web, then sign in again."

export function orgMfaPolicyBlocks(input: {
  policyRequiresMfa: boolean
  assuranceLevel: string | null | undefined
}) {
  return input.policyRequiresMfa && input.assuranceLevel !== "aal2"
}

/**
 * The `aal` claim of a bearer token that Supabase has already validated.
 * Decoding is not verification - only call this after `auth.getUser(token)`.
 */
export function assuranceLevelFromAccessToken(accessToken: string): string | null {
  const segments = accessToken.split(".")
  if (segments.length !== 3) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"))
    if (!payload || typeof payload !== "object") return null
    const aal = Reflect.get(payload, "aal")
    return typeof aal === "string" ? aal : null
  } catch {
    return null
  }
}
