import { NextResponse } from "next/server"

import { projectIdFromDocumentStoragePath } from "@/lib/files/content-policy"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { completeFilesMultipartUpload, ensureOrgScopedPath } from "@/lib/storage/files-storage"

export async function POST(request: Request) {
  try {
    const { orgId, userId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null
    const parts = Array.isArray(body?.parts) ? body.parts : []

    if (!storagePath || !uploadId || parts.length === 0) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const normalizedParts = parts.map((part: any) => ({
      partNumber: Number(part.partNumber),
      etag: String(part.etag ?? ""),
    }))

    if (
      normalizedParts.some((part: { partNumber: number; etag: string }) =>
        !Number.isInteger(part.partNumber) || part.partNumber < 1 || !part.etag
      )
    ) {
      return NextResponse.json({ error: "Invalid multipart parts." }, { status: 400 })
    }

    const normalizedStoragePath = ensureOrgScopedPath(orgId, storagePath)
    const projectId = projectIdFromDocumentStoragePath(orgId, normalizedStoragePath)
    if (!projectId) {
      return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
    }
    try {
      await requireProjectPermission(userId, projectId, "docs.upload")
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    const service = createServiceSupabaseClient()
    const result = await completeFilesMultipartUpload({
      supabase: service,
      orgId,
      path: normalizedStoragePath,
      uploadId,
      parts: normalizedParts,
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error("[documents multipart complete] failed:", error)
    return NextResponse.json({ error: "Failed to complete multipart upload." }, { status: 500 })
  }
}
