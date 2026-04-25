import { NextRequest, NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"

function contentTypeForPath(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".json")) return "application/json; charset=utf-8"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".dzi")) return "application/xml; charset=utf-8"
  return "application/octet-stream"
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  await requireOrgMembership()

  const { path } = await context.params
  const normalizedPath = path.join("/")
  if (!normalizedPath) {
    return NextResponse.json({ error: "Missing tile path" }, { status: 400 })
  }

  try {
    const supabase = createServiceSupabaseClient()
    const bytes = await downloadTilesObject({
      supabase,
      path: normalizedPath,
    })

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "content-type": contentTypeForPath(normalizedPath),
        "cache-control": "private, max-age=31536000, immutable",
      },
    })
  } catch (error) {
    console.error("[drawings tiles proxy] Failed to load tile:", normalizedPath, error)
    return NextResponse.json({ error: "Tile not found" }, { status: 404 })
  }
}

export const runtime = "nodejs"
