import { NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "node:crypto"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"

const COOKIE_NAME = process.env.DRAWINGS_TILES_COOKIE_NAME ?? "arc_tiles"
const COOKIE_SECRET = process.env.DRAWINGS_TILES_COOKIE_SECRET

function contentTypeForPath(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".json")) return "application/json; charset=utf-8"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".dzi")) return "application/xml; charset=utf-8"
  return "application/octet-stream"
}

/**
 * Verify the signed arc_tiles cookie (same HMAC scheme the CDN validates —
 * see tiles-cookie/route.ts). A valid cookie lets us skip the Supabase Auth
 * round trip that otherwise runs on EVERY tile request.
 */
function verifyTilesCookie(token: string | undefined): { orgId: string } | null {
  if (!token || !COOKIE_SECRET) return null

  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [payloadB64, signature] = parts

  const expected = createHmac("sha256", COOKIE_SECRET)
    .update(payloadB64)
    .digest("base64url")
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8")
    )
    if (typeof payload !== "object" || payload === null) return null
    const { org_id: orgId, exp } = payload as { org_id?: unknown; exp?: unknown }
    if (typeof orgId !== "string" || !orgId) return null
    if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000)) return null
    return { orgId }
  } catch {
    return null
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  if (candidate.name === "NoSuchKey" || candidate.name === "NotFound") return true
  return candidate.$metadata?.httpStatusCode === 404
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const normalizedPath = path.join("/")
  if (!normalizedPath) {
    return NextResponse.json({ error: "Missing tile path" }, { status: 400 })
  }

  // Fast path: a valid signed tiles cookie. Fall back to full auth only when
  // it's absent or invalid.
  const cookieAuth = verifyTilesCookie(request.cookies.get(COOKIE_NAME)?.value)
  const orgId = cookieAuth
    ? cookieAuth.orgId
    : (await requireOrgMembership()).orgId

  // Tile paths are prefixed with the owning org id — restrict access to the
  // requester's active org so members of other orgs can't fetch tiles by path.
  if (!normalizedPath.startsWith(`${orgId}/`)) {
    return NextResponse.json({ error: "Tile not found" }, { status: 404 })
  }

  const supabase = createServiceSupabaseClient()
  let bytes: Buffer

  try {
    bytes = await downloadTilesObject({ supabase, path: normalizedPath })
  } catch (error) {
    if (isNotFoundError(error)) {
      return NextResponse.json(
        { error: "Tile not found" },
        { status: 404, headers: { "cache-control": "no-store" } }
      )
    }

    // Transient failure (network/R2 hiccup): retry once, then surface a 502
    // that nothing caches so the client can retry.
    await sleep(150)
    try {
      bytes = await downloadTilesObject({ supabase, path: normalizedPath })
    } catch (retryError) {
      if (isNotFoundError(retryError)) {
        return NextResponse.json(
          { error: "Tile not found" },
          { status: 404, headers: { "cache-control": "no-store" } }
        )
      }
      console.error(
        "[drawings tiles proxy] Failed to load tile:",
        normalizedPath,
        retryError
      )
      return NextResponse.json(
        { error: "Tile temporarily unavailable" },
        { status: 502, headers: { "cache-control": "no-store" } }
      )
    }
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentTypeForPath(normalizedPath),
      "cache-control": "private, max-age=31536000, immutable",
    },
  })
}

export const runtime = "nodejs"
