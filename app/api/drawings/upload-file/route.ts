import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"

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

    if (file.type !== "application/pdf") {
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
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${orgId}/${projectId}/drawings/uploads/${timestamp}_${safeName}`
    const bytes = Buffer.from(await file.arrayBuffer())

    const service = createServiceSupabaseClient()
    const result = await uploadDrawingPdfObject({
      supabase: service,
      orgId,
      path: storagePath,
      bytes,
      contentType: file.type,
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      provider: result.provider,
    })
  } catch (error) {
    console.error("[drawings upload file] failed:", error)
    return NextResponse.json({ error: "Failed to upload file." }, { status: 500 })
  }
}

export const runtime = "nodejs"
