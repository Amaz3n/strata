import { NextResponse } from "next/server"
import { ZodError } from "zod"

import { prepareProjectDocumentUpload, UploadPreparationError } from "@/lib/services/files"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesUploadUrl } from "@/lib/storage/files-storage"
import { projectUploadRequestSchema } from "@/lib/validation/files"

export async function POST(request: Request) {
  try {
    const input = projectUploadRequestSchema.parse(await request.json())
    const prepared = await prepareProjectDocumentUpload(input)

    const result = await createFilesUploadUrl({
      supabase: createServiceSupabaseClient(),
      orgId: prepared.orgId,
      path: prepared.storagePath,
      contentType: prepared.contentType,
      cacheControl: "private, max-age=3600",
      expiresIn: 900,
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      uploadUrl: result.uploadUrl,
      provider: result.provider,
    })
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }
    if (error instanceof UploadPreparationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[documents upload-url] failed:", error)
    return NextResponse.json({ error: "Failed to create upload URL." }, { status: 500 })
  }
}
