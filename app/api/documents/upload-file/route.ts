import { NextResponse } from "next/server"
import { ZodError } from "zod"

import { logger } from "@/lib/logging/logger"
import { prepareProjectDocumentUpload, UploadPreparationError } from "@/lib/services/files"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesStorageProvider, uploadFilesObject } from "@/lib/storage/files-storage"
import { projectUploadRequestSchema } from "@/lib/validation/files"

export async function POST(request: Request) {
  let orgId: string | undefined
  let projectId: string | undefined

  try {
    const formData = await request.formData()
    const file = formData.get("file")

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const input = projectUploadRequestSchema.parse({
      projectId: formData.get("projectId"),
      fileName: file.name,
      contentType: file.type || undefined,
      fileSize: file.size,
    })
    projectId = input.projectId

    const prepared = await prepareProjectDocumentUpload(input)
    orgId = prepared.orgId

    const result = await uploadFilesObject({
      supabase: createServiceSupabaseClient(),
      orgId: prepared.orgId,
      path: prepared.storagePath,
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: prepared.contentType,
      cacheControl: "private, max-age=3600",
    })

    return NextResponse.json({
      storagePath: result.storagePath,
      provider: getFilesStorageProvider(),
    })
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }
    if (error instanceof UploadPreparationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error("documents.upload_file.failed", {
      domain: "documents",
      route: "/api/documents/upload-file",
      orgId,
      projectId,
      error,
    })
    return NextResponse.json({ error: "Failed to upload file." }, { status: 500 })
  }
}
