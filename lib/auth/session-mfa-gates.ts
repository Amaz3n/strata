import type { SupabaseClient } from "@supabase/supabase-js"

import {
  signMfaGateCookie,
  signOrgMfaPolicyCookie,
  verifyMfaGateCookie,
  verifyOrgMfaPolicyCookie,
} from "@/lib/auth/mfa-gate-cookie"

/**
 * The two questions the proxy asks of a session that is not yet `aal2`, each
 * answered from the Auth server or the database and never from client storage.
 *
 * `unavailable` means the answer could not be read. The proxy refuses the
 * request rather than guessing: two-factor is a security control, so a failed
 * lookup must not let a session that owes a code, or owes an enrollment, through.
 * A "no" is signed into a short-lived cookie (`proof`) so a member who owes
 * nothing does not pay the lookup on every navigation; a "yes" is never cached.
 */
export type SessionGate =
  | { kind: "pass"; proof?: string }
  | { kind: "required" }
  | { kind: "unavailable" }

type Claims = { sub?: unknown; session_id?: unknown }

function sessionIdentity(claims: Claims) {
  const sub = typeof claims.sub === "string" ? claims.sub : null
  const sessionId = typeof claims.session_id === "string" ? claims.session_id : null
  return sub && sessionId ? { sub, sessionId } : null
}

/**
 * Whether this session's user has a verified factor and so must step up with a
 * code. Supabase's assurance helper reads client-controlled session storage, so
 * the Auth server is asked instead.
 */
export async function resolveStepUpGate(supabase: SupabaseClient, claims: Claims, cookie: string | undefined): Promise<SessionGate> {
  const identity = sessionIdentity(claims)
  if (identity && (await verifyMfaGateCookie(cookie, identity))) return { kind: "pass" }

  const { data, error } = await supabase.auth.getUser()
  if (error) return { kind: "unavailable" }
  if ((data.user?.factors ?? []).some((factor) => factor.status === "verified")) return { kind: "required" }
  return { kind: "pass", proof: identity ? (await signMfaGateCookie(identity)) ?? undefined : undefined }
}

/**
 * Whether an organization the user belongs to requires two-factor, so a user
 * with no factor must enroll before using the app. Members read their own orgs'
 * policies under RLS. Any one organization requiring it applies to the person,
 * because the factor belongs to the person, not to the organization.
 */
export async function resolveOrgEnrollmentGate(supabase: SupabaseClient, claims: Claims, cookie: string | undefined): Promise<SessionGate> {
  const identity = sessionIdentity(claims)
  if (identity && (await verifyOrgMfaPolicyCookie(cookie, identity))) return { kind: "pass" }

  const { data, error } = await supabase.from("org_security_policies").select("org_id").eq("require_mfa", true).limit(1)
  if (error) return { kind: "unavailable" }
  if ((data ?? []).length > 0) return { kind: "required" }
  return { kind: "pass", proof: identity ? (await signOrgMfaPolicyCookie(identity)) ?? undefined : undefined }
}
