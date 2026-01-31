import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createDrawingPdfUploadUrl } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const body = await request.json()
    const projectId = typeof body?.projectId === "string" ? body.projectId : null
    const fileName = typeof body?.fileName === "string" ? body.fileName : null
    const contentType = typeof body?.contentType === "string" ? body.contentType : null

    if (!projectId || !fileName || !contentType) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    if (contentType !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are supported." }, { status: 400 })
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
    const storagePath = `${orgId}/${projectId}/drawings/sets/${timestamp}_${safeName}`

    const service = createServiceSupabaseClient()
    const result = await createDrawingPdfUploadUrl({
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
  } catch (error) {
    return NextResponse.json({ error: "Failed to create upload URL." }, { status: 500 })
  }
}
