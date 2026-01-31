import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken } from "@/lib/services/portal-access"
import { deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
]

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const portalToken = await validatePortalToken(token)

    if (!portalToken) {
      return NextResponse.json({ error: "Invalid or expired portal access" }, { status: 401 })
    }

    if (portalToken.portal_type !== "sub" || !portalToken.company_id) {
      return NextResponse.json({ error: "Invalid portal type" }, { status: 403 })
    }

    // Check permission
    if (!portalToken.permissions.can_upload_compliance_docs) {
      return NextResponse.json(
        { error: "You do not have permission to upload compliance documents" },
        { status: 403 }
      )
    }

    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File size exceeds 25MB limit" }, { status: 400 })
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Please upload a PDF or image." },
        { status: 400 }
      )
    }

    const supabase = createServiceSupabaseClient()

    // Generate unique storage path
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${portalToken.org_id}/compliance/${portalToken.company_id}/${timestamp}_${safeName}`

    const bytes = Buffer.from(await file.arrayBuffer())
    await uploadFilesObject({
      supabase,
      orgId: portalToken.org_id,
      path: storagePath,
      bytes,
      contentType: file.type,
      upsert: false,
    })

    // Create file record in database
    const { data: fileRecord, error: dbError } = await supabase
      .from("files")
      .insert({
        org_id: portalToken.org_id,
        project_id: portalToken.project_id,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        size_bytes: file.size,
        visibility: "private",
        metadata: {
          uploaded_via_portal: true,
          portal_token_id: portalToken.id,
          company_id: portalToken.company_id,
          file_type: "compliance_document",
        },
      })
      .select("id, file_name")
      .single()

    if (dbError || !fileRecord) {
      // Try to clean up the uploaded file if db insert fails
      await deleteFilesObjects({
        supabase,
        orgId: portalToken.org_id,
        paths: [storagePath],
      })
      console.error("DB insert error:", dbError)
      return NextResponse.json({ error: "Failed to save file record" }, { status: 500 })
    }

    return NextResponse.json({
      fileId: fileRecord.id,
      fileName: fileRecord.file_name,
    })
  } catch (err) {
    console.error("Failed to upload compliance file:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upload file" },
      { status: 500 }
    )
  }
}
