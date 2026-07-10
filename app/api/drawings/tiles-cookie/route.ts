import { NextRequest, NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { createTilesCookieResponse, isTilesCookieConfigured } from "@/lib/drawings-tiles-cookie"

async function handleRequest(_request: NextRequest): Promise<NextResponse> {
  if (!isTilesCookieConfigured()) {
    return NextResponse.json({ error: "Missing DRAWINGS_TILES_COOKIE_SECRET" }, { status: 500 })
  }

  const { user, orgId } = await requireOrgMembership()
  return createTilesCookieResponse({ sub: user.id, orgId })
}

export async function GET(request: NextRequest) {
  return handleRequest(request)
}

export async function POST(request: NextRequest) {
  return handleRequest(request)
}

export const runtime = "nodejs"
