import { NextResponse } from "next/server"
import { ZodError } from "zod"

import { prepareProjectDocumentUpload, UploadPreparationError } from "@/lib/services/files"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesMultipartUpload } from "@/lib/storage/files-storage"
import { projectUploadRequestSchema } from "@/lib/validation/files"

const PART_SIZE = 16 * 1024 * 1024

export async function POST(request: Request) {
  try {
    const input = projectUploadRequestSchema.parse(await request.json())
    const prepared = await prepareProjectDocumentUpload(input)

    const result = await createFilesMultipartUpload({
      supabase: createServiceSupabaseClient(),
      orgId: prepared.orgId,
      path: prepared.storagePath,
      contentType: prepared.contentType,
      cacheControl: "private, max-age=3600",
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      uploadId: result.uploadId,
      provider: result.provider,
      partSize: PART_SIZE,
    })
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }
    if (error instanceof UploadPreparationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[documents multipart create] failed:", error)
    return NextResponse.json({ error: "Failed to create multipart upload." }, { status: 500 })
  }
}
