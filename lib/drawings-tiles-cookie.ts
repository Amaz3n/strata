import { createHmac } from "node:crypto"

import { NextResponse } from "next/server"

/**
 * Shared minting logic for the signed `arc_tiles` cookie that grants access to
 * the drawings tile CDN/proxy. Two routes mint it with identical scope/TTL:
 * - app/api/drawings/tiles-cookie (authed app users)
 * - app/api/portal/drawings/[token]/tiles-cookie (validated portal tokens)
 * The CDN and app/api/drawings/tiles/[...path] validate the same HMAC scheme.
 */

const COOKIE_NAME = process.env.DRAWINGS_TILES_COOKIE_NAME ?? "arc_tiles"
const COOKIE_SECRET = process.env.DRAWINGS_TILES_COOKIE_SECRET
const COOKIE_DOMAIN = process.env.DRAWINGS_TILES_COOKIE_DOMAIN ?? ".arcnaples.com"
const COOKIE_PATH = process.env.DRAWINGS_TILES_COOKIE_PATH ?? "/drawings-tiles/"
const COOKIE_TTL_SECONDS = Number(process.env.DRAWINGS_TILES_COOKIE_TTL_SECONDS ?? "3600")

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url")
}

function signPayload(payloadB64: string, secret: string) {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url")
}

function buildSignedToken(payload: Record<string, unknown>, secret: string) {
  const payloadJson = JSON.stringify(payload)
  const payloadB64 = base64UrlEncode(payloadJson)
  const signature = signPayload(payloadB64, secret)
  return `${payloadB64}.${signature}`
}

/** True when the signing secret is configured (checked before any auth work). */
export function isTilesCookieConfigured() {
  return !!COOKIE_SECRET
}

/**
 * Build the `{ ok, exp }` JSON response carrying both copies of the signed
 * tiles cookie (domain-scoped for the CDN, host-scoped for the local proxy).
 * Returns a 500 response when the signing secret is not configured.
 */
export function createTilesCookieResponse({ sub, orgId }: { sub: string; orgId: string }) {
  if (!COOKIE_SECRET) {
    return NextResponse.json({ error: "Missing DRAWINGS_TILES_COOKIE_SECRET" }, { status: 500 })
  }

  const now = Math.floor(Date.now() / 1000)
  const exp = now + COOKIE_TTL_SECONDS
  const token = buildSignedToken({ sub, org_id: orgId, exp }, COOKIE_SECRET)

  const response = NextResponse.json({ ok: true, exp })
  response.headers.set("Cache-Control", "no-store")
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: COOKIE_DOMAIN,
    path: COOKIE_PATH,
    maxAge: COOKIE_TTL_SECONDS,
  })

  // Second, host-scoped copy for the /api/drawings/tiles proxy. Off-production
  // hosts (localhost, previews) reject the .arcnaples.com domain cookie above,
  // so without this the proxy would run full Supabase auth on every tile.
  // Appended raw because ResponseCookies dedupes by name.
  response.headers.append(
    "set-cookie",
    [
      `${COOKIE_NAME}=${token}`,
      "Path=/api/drawings/tiles/",
      `Max-Age=${COOKIE_TTL_SECONDS}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ].join("; ")
  )

  return response
}
