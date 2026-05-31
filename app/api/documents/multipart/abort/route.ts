import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { abortFilesMultipartUpload, ensureOrgScopedPath } from "@/lib/storage/files-storage"

export async function POST(request: Request) {
  try {
    const { orgId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null

    if (!storagePath || !uploadId) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    await abortFilesMultipartUpload({
      supabase: service,
      orgId,
      path: ensureOrgScopedPath(orgId, storagePath),
      uploadId,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[documents multipart abort] failed:", error)
    return NextResponse.json({ error: "Failed to abort multipart upload." }, { status: 500 })
  }
}

export const runtime = "nodejs"
