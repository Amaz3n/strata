import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesUploadUrl } from "@/lib/storage/files-storage"

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
    const result = await createFilesUploadUrl({
      supabase: service,
      orgId,
      path: storagePath,
      contentType,
      cacheControl: "private, max-age=3600",
      expiresIn: 900,
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      uploadUrl: result.uploadUrl,
      provider: result.provider,
    })
  } catch (error) {
    console.error("[documents upload-url] failed:", error)
    return NextResponse.json({ error: "Failed to create upload URL." }, { status: 500 })
  }
}

export const runtime = "nodejs"
