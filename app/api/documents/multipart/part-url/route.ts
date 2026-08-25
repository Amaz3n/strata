import { NextResponse } from "next/server"

import { projectIdFromDocumentStoragePath } from "@/lib/files/content-policy"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesMultipartPartUrl, ensureOrgScopedPath } from "@/lib/storage/files-storage"

export async function POST(request: Request) {
  try {
    const { orgId, userId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null
    const partNumber = Number(body?.partNumber)

    if (!storagePath || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
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
    const result = await createFilesMultipartPartUrl({
      supabase: service,
      orgId,
      path: normalizedStoragePath,
      uploadId,
      partNumber,
      expiresIn: 900,
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error("[documents multipart part-url] failed:", error)
    return NextResponse.json({ error: "Failed to create part URL." }, { status: 500 })
  }
}
