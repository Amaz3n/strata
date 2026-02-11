import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ensureOrgScopedPath } from "@/lib/storage/files-storage"
import { createDrawingImageUploadUrl } from "@/lib/storage/drawings-images-storage"

export async function POST(request: Request) {
  try {
    const { orgId } = await requireOrgContext()
    const body = await request.json()

    const rawPath = typeof body?.path === "string" ? body.path : null
    const contentType =
      typeof body?.contentType === "string" ? body.contentType : "image/webp"

    if (!rawPath) {
      return NextResponse.json({ error: "Missing required path." }, { status: 400 })
    }

    const storagePath = ensureOrgScopedPath(orgId, rawPath)

    if (!storagePath.startsWith(`${orgId}/`)) {
      return NextResponse.json({ error: "Invalid path scope." }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    const result = await createDrawingImageUploadUrl({
      supabase: service,
      orgId,
      path: storagePath,
      contentType,
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      uploadUrl: result.uploadUrl,
      provider: result.provider,
    })
  } catch {
    return NextResponse.json(
      { error: "Failed to create drawing image upload URL." },
      { status: 500 }
    )
  }
}
