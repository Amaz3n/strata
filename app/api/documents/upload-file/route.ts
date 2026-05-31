import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"

export async function POST(request: Request) {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const formData = await request.formData()
    const projectId =
      typeof formData.get("projectId") === "string"
        ? (formData.get("projectId") as string)
        : null
    const file = formData.get("file")

    if (!projectId || !(file instanceof File)) {
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
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${orgId}/${projectId}/documents/uploads/${timestamp}_${safeName}`
    const bytes = Buffer.from(await file.arrayBuffer())

    const service = createServiceSupabaseClient()
    const result = await uploadFilesObject({
      supabase: service,
      orgId,
      path: storagePath,
      bytes,
      contentType: file.type || "application/octet-stream",
      cacheControl: "private, max-age=3600",
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      provider: "r2",
    })
  } catch (error) {
    console.error("[documents upload-file] failed:", error)
    return NextResponse.json({ error: "Failed to upload file." }, { status: 500 })
  }
}

export const runtime = "nodejs"
