import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesMultipartUpload } from "@/lib/storage/files-storage"

const PART_SIZE = 16 * 1024 * 1024

export async function POST(request: Request) {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const body = await request.json()
    const projectId = typeof body?.projectId === "string" ? body.projectId : null
    const fileName = typeof body?.fileName === "string" ? body.fileName : null
    const contentType =
      typeof body?.contentType === "string" && body.contentType.trim()
        ? body.contentType
        : "application/octet-stream"

    if (!projectId || !fileName) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("org_id", orgId)
      .maybeSingle()

    if (projectError || !project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 })
    }

    const timestamp = Date.now()
    const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${orgId}/${projectId}/documents/uploads/${timestamp}_${safeName}`

    const service = createServiceSupabaseClient()
    const result = await createFilesMultipartUpload({
      supabase: service,
      orgId,
      path: storagePath,
      contentType,
      cacheControl: "private, max-age=3600",
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      uploadId: result.uploadId,
      provider: result.provider,
      partSize: PART_SIZE,
    })
  } catch (error) {
    console.error("[documents multipart create] failed:", error)
    return NextResponse.json({ error: "Failed to create multipart upload." }, { status: 500 })
  }
}

export const runtime = "nodejs"
