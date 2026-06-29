import { NextRequest, NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createInitialVersion } from "@/lib/services/file-versions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

const MAX_FILE_SIZE = 25 * 1024 * 1024
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
  { params }: { params: Promise<{ companyId: string }> },
) {
  try {
    const { companyId } = await params
    const { supabase, orgId, userId } = await requireOrgContext()

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", companyId)
      .maybeSingle()

    if (companyError || !company) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 })
    }

    const formData = await request.formData()
    const file = formData.get("file")

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File size exceeds 25MB limit" }, { status: 400 })
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Please upload a PDF or image." },
        { status: 400 },
      )
    }

    const service = createServiceSupabaseClient()
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${orgId}/compliance/${companyId}/${timestamp}_${safeName}`
    const bytes = Buffer.from(await file.arrayBuffer())

    await uploadFilesObject({
      supabase: service,
      orgId,
      path: storagePath,
      bytes,
      contentType: file.type,
      upsert: false,
    })

    const { data: fileRecord, error: fileError } = await supabase
      .from("files")
      .insert({
        org_id: orgId,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        size_bytes: file.size,
        visibility: "private",
        category: "other",
        source: "upload",
        uploaded_by: userId,
        metadata: {
          uploaded_by_builder: true,
          company_id: companyId,
          file_type: "compliance_document",
        },
      })
      .select("id, file_name")
      .single()

    if (fileError || !fileRecord) {
      await deleteFilesObjects({
        supabase: service,
        orgId,
        paths: [storagePath],
      })
      return NextResponse.json({ error: "Failed to save file record" }, { status: 500 })
    }

    await createInitialVersion(
      {
        fileId: fileRecord.id,
        storagePath,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      },
      orgId,
    )

    return NextResponse.json({
      fileId: fileRecord.id,
      fileName: fileRecord.file_name,
    })
  } catch (error) {
    console.error("Failed to upload company compliance file:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload file" },
      { status: 500 },
    )
  }
}

export const runtime = "nodejs"
