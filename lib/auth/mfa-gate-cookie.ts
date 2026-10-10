/**
 * Signed proof that a session's user had no verified MFA factor.
 *
 * The proxy must know whether an aal1 session needs to be stepped up to aal2.
 * That answer only exists on the Auth server (`getUser().factors`) — the copy in
 * cookie storage is client-controlled, so trusting it would let anyone strip
 * their factors and walk past the challenge. Asking GoTrue on every request is
 * correct but costs a network round-trip on every navigation a non-MFA user
 * makes, which is most of them, forever.
 *
 * So the proxy asks once and signs the negative answer. The signature is the
 * trust boundary: a forged or edited cookie fails verification and falls back to
 * the live lookup. Binding to `session_id` means a new sign-in cannot inherit an
 * older session's proof, and the short TTL bounds how long a factor enrolled on
 * a *different* session stays unnoticed here. Enrolling on THIS session raises
 * it to aal2, which skips this gate entirely.
 *
 * Web Crypto rather than node:crypto — the proxy runs on the Edge runtime.
 */

export const MFA_GATE_COOKIE = "arc_mfa_gate"
export const MFA_GATE_TTL_SECONDS = 600
/**
 * Signed proof that none of the session user's organizations requires
 * two-factor. Same trust model and TTL as the gate cookie above, with its own
 * signature domain so neither can stand in for the other.
 */
export const ORG_MFA_POLICY_COOKIE = "arc_org_mfa_policy"

const encoder = new TextEncoder()
let cachedKey: Promise<CryptoKey> | null = null

/**
 * Keyed on the service-role secret so no new environment variable has to be
 * provisioned before the proxy can stop calling GoTrue. Domain-separated by the
 * message prefix below, so this signature can never be replayed as another one.
 */
function signingKey(): Promise<CryptoKey> | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) return null
  if (!cachedKey) {
    cachedKey = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ])
  }
  return cachedKey
}

function toBase64Url(bytes: ArrayBuffer) {
  let binary = ""
  const view = new Uint8Array(bytes)
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sign(purpose: string, sub: string, sessionId: string, expiresAt: number) {
  const key = signingKey()
  if (!key) return null
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key,
    encoder.encode(`${purpose}:v1:${sub}:${sessionId}:${expiresAt}`),
  )
  return toBase64Url(signature)
}

/** Constant-time compare so a wrong signature leaks nothing through timing. */
function equals(left: string, right: string) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

export type MfaGateIdentity = { sub: string; sessionId: string }

async function signProof(purpose: string, { sub, sessionId }: MfaGateIdentity) {
  const expiresAt = Math.floor(Date.now() / 1000) + MFA_GATE_TTL_SECONDS
  const signature = await sign(purpose, sub, sessionId, expiresAt)
  if (!signature) return null
  return `${expiresAt}.${signature}`
}

async function verifyProof(purpose: string, value: string | undefined, { sub, sessionId }: MfaGateIdentity) {
  if (!value) return false
  const separator = value.indexOf(".")
  if (separator <= 0) return false

  const expiresAt = Number(value.slice(0, separator))
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false

  const expected = await sign(purpose, sub, sessionId, expiresAt)
  if (!expected) return false
  return equals(expected, value.slice(separator + 1))
}

/** Cookie value asserting this session's user has no verified factor. */
export function signMfaGateCookie(identity: MfaGateIdentity) {
  return signProof("arc-mfa-gate", identity)
}

/**
 * True only for an unexpired, correctly signed proof issued to this exact
 * session. Anything else - malformed, expired, another session's, unsigned
 * because the secret is missing - returns false and sends the caller back to
 * the authoritative lookup.
 */
export function verifyMfaGateCookie(value: string | undefined, identity: MfaGateIdentity) {
  return verifyProof("arc-mfa-gate", value, identity)
}

/** Cookie value asserting no organization this user belongs to requires two-factor. */
export function signOrgMfaPolicyCookie(identity: MfaGateIdentity) {
  return signProof("arc-org-mfa-policy", identity)
}

export function verifyOrgMfaPolicyCookie(value: string | undefined, identity: MfaGateIdentity) {
  return verifyProof("arc-org-mfa-policy", value, identity)
}
