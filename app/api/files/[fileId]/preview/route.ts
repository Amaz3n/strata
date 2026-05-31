import { NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, getFilesObjectStream, uploadFilesObject } from "@/lib/storage/files-storage"

function isHeicPreviewCandidate(file: {
  mime_type?: string | null
  file_name?: string | null
  storage_path?: string | null
}) {
  const mimeType = file.mime_type
  const lowerMime = mimeType?.toLowerCase() ?? ""
  const lowerName = file.file_name?.toLowerCase() ?? ""
  const lowerPath = file.storage_path?.toLowerCase() ?? ""
  return (
    lowerMime === "image/heic" ||
    lowerMime === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif") ||
    lowerPath.endsWith(".heic") ||
    lowerPath.endsWith(".heif")
  )
}

export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params
    const svc = createServiceSupabaseClient()

    const { data: file, error } = await svc
      .from("files")
      .select("id, org_id, project_id, file_name, storage_path, mime_type, metadata")
      .eq("id", fileId)
      .maybeSingle()

    if (error || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    try {
      await requireOrgMembership(file.org_id)
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata as any : {}
    const preview = metadata.preview && typeof metadata.preview === "object" ? metadata.preview : {}
    let thumbnailPath = typeof preview.thumbnail_path === "string" ? preview.thumbnail_path : null

    if (!thumbnailPath && isHeicPreviewCandidate(file)) {
      thumbnailPath = await generateAndStoreHeicPreview(svc, file)
    }

    if (!thumbnailPath) {
      return NextResponse.json({ error: "Preview not ready" }, { status: 404 })
    }

    const object = await getFilesObjectStream({
      supabase: svc,
      orgId: file.org_id,
      path: thumbnailPath,
    })

    const headers = new Headers()
    headers.set("Content-Type", object.contentType ?? "image/webp")
    headers.set("Cache-Control", "private, max-age=3600")
    headers.set("X-Content-Type-Options", "nosniff")
    if (object.etag) headers.set("ETag", object.etag)
    if (object.contentLength !== undefined) {
      headers.set("Content-Length", String(object.contentLength))
    }

    return new Response(object.body as BodyInit, { status: 200, headers })
  } catch (error) {
    console.error("[api/files/[fileId]/preview] Failed:", error)
    return NextResponse.json({ error: "Unable to serve preview" }, { status: 500 })
  }
}

export const runtime = "nodejs"

async function generateAndStoreHeicPreview(supabase: ReturnType<typeof createServiceSupabaseClient>, file: any) {
  const sourceBytes = await downloadFilesObject({
    supabase,
    orgId: file.org_id,
    path: file.storage_path,
  })

  const preview = await convertHeicToJpegPreview(sourceBytes)

  const safeBaseName = String(file.file_name ?? "preview").replace(/[^a-zA-Z0-9.-]/g, "_")
  const thumbnailPath = `${file.org_id}/${file.project_id ?? "general"}/documents/previews/${file.id}/${Date.now()}_${safeBaseName}.jpg`

  await uploadFilesObject({
    supabase,
    orgId: file.org_id,
    path: thumbnailPath,
    bytes: preview.bytes,
    contentType: "image/jpeg",
    cacheControl: "private, max-age=86400",
  })

  const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata as any : {}
  await supabase
    .from("files")
    .update({
      metadata: {
        ...metadata,
        preview: {
          ...(metadata.preview ?? {}),
          status: "ready",
          thumbnail_path: thumbnailPath,
          width: preview.width,
          height: preview.height,
          content_type: "image/jpeg",
          generated_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", file.id)

  return thumbnailPath
}

async function convertHeicToJpegPreview(sourceBytes: Buffer): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const convertModule = await import("heic-convert")
  const convert = (convertModule as any).default ?? convertModule
  const jpegBytes = await convert({
    buffer: sourceBytes,
    format: "JPEG",
    quality: 0.92,
  })

  const sharp = (await import("sharp")).default
  const result = await sharp(Buffer.from(jpegBytes), { limitInputPixels: false })
    .rotate()
    .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })

  return {
    bytes: new Uint8Array(result.data),
    width: result.info.width,
    height: result.info.height,
  }
}
