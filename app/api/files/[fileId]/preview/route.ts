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

interface PreviewSize {
  width: number
  path: string
  content_type: string
}

function isPreviewSize(value: unknown): value is PreviewSize {
  if (!value || typeof value !== "object") return false
  const size = value as Record<string, unknown>
  return (
    typeof size.width === "number" &&
    typeof size.path === "string" &&
    typeof size.content_type === "string"
  )
}

/**
 * Pick a ladder rung for the requested width, preferring AVIF when the browser
 * says it can take it. Falls back to the single legacy thumbnail when a file
 * predates the ladder.
 */
function selectLadderPath(
  sizes: unknown,
  requestedWidth: number | null,
  acceptsAvif: boolean,
): string | null {
  if (!Array.isArray(sizes)) return null
  const entries = sizes.filter(isPreviewSize)
  if (entries.length === 0) return null

  const preferred = acceptsAvif ? "image/avif" : "image/webp"
  const candidates = entries.filter((entry) => entry.content_type === preferred)
  const pool = candidates.length > 0 ? candidates : entries

  const widths = [...new Set(pool.map((entry) => entry.width))].sort((a, b) => a - b)
  const target =
    requestedWidth === null
      ? widths[widths.length - 1]
      : widths.find((width) => width >= requestedWidth) ?? widths[widths.length - 1]

  return pool.find((entry) => entry.width === target)?.path ?? null
}

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
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

    const requestedWidthRaw = new URL(req.url).searchParams.get("w")
    const parsedWidth = requestedWidthRaw ? Number.parseInt(requestedWidthRaw, 10) : Number.NaN
    const requestedWidth = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : null
    const acceptsAvif = (req.headers.get("accept") ?? "").includes("image/avif")

    let thumbnailPath =
      selectLadderPath(preview.sizes, requestedWidth, acceptsAvif) ??
      (typeof preview.thumbnail_path === "string" ? preview.thumbnail_path : null)

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
    // The response body depends on the client's image-format support, so it
    // must not be reused across browsers with different Accept headers.
    headers.set("Vary", "Accept")
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
