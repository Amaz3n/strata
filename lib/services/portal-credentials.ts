import "server-only"

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

/**
 * Every credential on the external (token/portal) surface derives from this
 * module: link tokens, PIN verification cookies, and account session cookies.
 *
 * Before this existed the same primitives were reimplemented in
 * portal-access.ts, bid-portal.ts and external-portal-auth.ts with subtly
 * different secrets and no shared expiry discipline. Add new external
 * credentials here, never inline.
 */

const PIN_COOKIE_PREFIX = "portal_pin"
const PIN_TTL_SECONDS = 60 * 60 * 12

export const MAX_CREDENTIAL_ATTEMPTS = 5
export const CREDENTIAL_LOCKOUT_MS = 15 * 60 * 1000

/**
 * One secret, no fallback chain. The previous chain silently degraded to
 * SUPABASE_SERVICE_ROLE_KEY, which tied link validity to the most dangerous
 * credential in the system and made it impossible to tell which secret was
 * actually live. Fail loudly instead.
 */
function portalSecret(): string {
  const secret = process.env.PORTAL_ACCESS_SECRET
  if (!secret || secret.length < 32) {
    throw new Error("PORTAL_ACCESS_SECRET must be set to a random string of at least 32 characters")
  }
  return secret
}

/** Purpose-separated keys so a lookup hash can never decrypt a stored token. */
function derivedKey(purpose: "lookup" | "encryption" | "cookie"): Buffer {
  return Buffer.from(hkdfSync("sha256", portalSecret(), "arc-portal-credentials", purpose, 32))
}

/**
 * Bid tokens keep their own key. Their hashes are all we hold — the plaintext
 * only ever existed in the invite email — so this secret can never be rotated
 * or folded into PORTAL_ACCESS_SECRET without invalidating every outstanding
 * bid invite. The algorithm must stay byte-identical for the same reason.
 */
export function hashBidToken(token: string): string {
  const secret = process.env.BID_PORTAL_SECRET
  if (!secret) {
    throw new Error("Missing BID_PORTAL_SECRET environment variable")
  }
  return createHmac("sha256", secret).update(token).digest("hex")
}

/** Session cookies are opaque random values; the DB stores only this hash. */
export function hashSessionToken(token: string): string {
  return createHmac("sha256", derivedKey("lookup")).update(`session:${token}`).digest("hex")
}

export function generatePortalToken(): string {
  return randomBytes(32).toString("hex")
}

/**
 * Deterministic lookup hash. Tokens arrive in a URL, so authentication needs a
 * stable index key — this is that key, and it is what the database stores.
 */
export function hashPortalToken(token: string): string {
  return createHmac("sha256", derivedKey("lookup")).update(token).digest("hex")
}

/**
 * Reversible at-rest storage, used only where a builder must be able to
 * re-display or reuse an already-issued link. Authentication never reads this;
 * it reads the lookup hash. AES-256-GCM, random IV per value.
 */
export function encryptPortalToken(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", derivedKey("encryption"), iv)
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".")
}

export function decryptPortalToken(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null
  const [ivPart, tagPart, dataPart] = encrypted.split(".")
  if (!ivPart || !tagPart || !dataPart) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey("encryption"), Buffer.from(ivPart, "base64"))
    decipher.setAuthTag(Buffer.from(tagPart, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * PIN cookies carry their own expiry inside the signed value. The previous
 * implementation signed only the token, so an exfiltrated cookie value stayed
 * valid until the secret rotated — cookie maxAge is client-honored and proves
 * nothing server-side.
 */
function signPinCookie(scope: string, expiresAtMs: number): string {
  const signature = createHmac("sha256", derivedKey("cookie")).update(`${scope}:${expiresAtMs}`).digest("hex")
  return `${expiresAtMs}.${signature}`
}

function pinCookieName(scope: string): string {
  const digest = createHmac("sha256", derivedKey("cookie")).update(`name:${scope}`).digest("hex")
  return `${PIN_COOKIE_PREFIX}_${digest.slice(0, 16)}`
}

export async function markPinVerified(scope: string): Promise<void> {
  const expiresAtMs = Date.now() + PIN_TTL_SECONDS * 1000
  const store = await cookies()
  store.set({
    name: pinCookieName(scope),
    value: signPinCookie(scope, expiresAtMs),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: PIN_TTL_SECONDS,
  })
}

export async function clearPinVerification(scope: string): Promise<void> {
  const store = await cookies()
  store.set({
    name: pinCookieName(scope),
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  })
}

export async function isPinVerified(scope: string): Promise<boolean> {
  const store = await cookies()
  const value = store.get(pinCookieName(scope))?.value
  if (!value) return false

  const [expiryPart, signature] = value.split(".")
  if (!expiryPart || !signature) return false

  const expiresAtMs = Number(expiryPart)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false

  return constantTimeEquals(value, signPinCookie(scope, expiresAtMs))
}

export interface LockoutState {
  attempts?: number | null
  locked_until?: string | null
}

export function isLockedOut(state: LockoutState): boolean {
  return !!state.locked_until && new Date(state.locked_until) > new Date()
}

/** Next attempt counter + lockout stamp after a failed credential check. */
export function nextLockoutState(state: LockoutState): { attempts: number; locked_until: string | null } {
  const attempts = (state.attempts ?? 0) + 1
  return {
    attempts,
    locked_until: attempts >= MAX_CREDENTIAL_ATTEMPTS ? new Date(Date.now() + CREDENTIAL_LOCKOUT_MS).toISOString() : null,
  }
}
