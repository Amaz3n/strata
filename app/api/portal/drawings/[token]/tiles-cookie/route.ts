import { NextRequest, NextResponse } from "next/server"

import { createTilesCookieResponse, isTilesCookieConfigured } from "@/lib/drawings-tiles-cookie"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

export const runtime = "nodejs"

/**
 * Mints the same signed `arc_tiles` cookie the authed app route mints, but for
 * portal visitors (clients/subs) identified by their portal token instead of a
 * Supabase session. Scope and TTL are identical — the cookie is org-scoped, so
 * a portal visitor can only fetch tiles under their own org's path prefix.
 */
async function handleRequest(_request: NextRequest, token: string): Promise<NextResponse> {
  if (!isTilesCookieConfigured()) {
    return NextResponse.json({ error: "Missing DRAWINGS_TILES_COOKIE_SECRET" }, { status: 500 })
  }

  let access
  try {
    access = await assertPortalActionAccess(token, { permission: "can_view_documents" })
  } catch {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 })
  }

  return createTilesCookieResponse({ sub: `portal:${access.id}`, orgId: access.org_id })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  return handleRequest(request, token)
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  return handleRequest(request, token)
}
