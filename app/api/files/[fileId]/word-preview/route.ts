import { NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { convertDocxToPreviewHtml } from "@/lib/services/word-preview"

function isDocxCandidate(file: {
  mime_type?: string | null
  file_name?: string | null
  storage_path?: string | null
}) {
  const lowerMime = file.mime_type?.toLowerCase() ?? ""
  const lowerName = file.file_name?.toLowerCase() ?? ""
  const lowerPath = file.storage_path?.toLowerCase() ?? ""
  return (
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx") ||
    lowerPath.endsWith(".docx")
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

    if (!isDocxCandidate(file)) {
      return NextResponse.json({ error: "Preview not supported" }, { status: 415 })
    }

    const metadata = file.metadata && typeof file.metadata === "object" ? (file.metadata as any) : {}
    const preview = metadata.preview && typeof metadata.preview === "object" ? metadata.preview : {}
    const htmlPath = typeof preview.html_path === "string" ? preview.html_path : null

    // Resolve the preview as an HTML string and return it buffered. We deliberately
    // avoid streaming the R2 object body through the Response here: the document is
    // small, and streaming it crashed in dev with "Controller is already closed".
    let html: string
    if (htmlPath) {
      const bytes = await downloadFilesObject({ supabase: svc, orgId: file.org_id, path: htmlPath })
      html = bytes.toString("utf-8")
    } else {
      // On-demand generation for files uploaded before HTML previews shipped.
      html = await generateAndStoreWordPreview(svc, file, metadata)
    }

    return new Response(html, { status: 200, headers: buildHtmlHeaders() })
  } catch (error) {
    console.error("[api/files/[fileId]/word-preview] Failed:", error)
    return NextResponse.json({ error: "Unable to render preview" }, { status: 500 })
  }
}

export const runtime = "nodejs"

function buildHtmlHeaders(): Headers {
  const headers = new Headers()
  headers.set("Content-Type", "text/html; charset=utf-8")
  headers.set("Cache-Control", "private, max-age=3600")
  headers.set("X-Content-Type-Options", "nosniff")
  // The document is rendered inside a sandboxed iframe; this is defense in depth.
  headers.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;")
  return headers
}

// Generates, stores, and returns the preview HTML string.
async function generateAndStoreWordPreview(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  file: any,
  metadata: Record<string, any>
): Promise<string> {
  const sourceBytes = await downloadFilesObject({
    supabase,
    orgId: file.org_id,
    path: file.storage_path,
  })

  const { html } = await convertDocxToPreviewHtml(sourceBytes)

  const safeBaseName = String(file.file_name ?? "preview").replace(/[^a-zA-Z0-9.-]/g, "_")
  const htmlPath = `${file.org_id}/${file.project_id ?? "general"}/documents/previews/${file.id}/${Date.now()}_${safeBaseName}.html`

  await uploadFilesObject({
    supabase,
    orgId: file.org_id,
    path: htmlPath,
    bytes: new TextEncoder().encode(html),
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, max-age=86400",
  })

  await supabase
    .from("files")
    .update({
      metadata: {
        ...metadata,
        preview: {
          ...(metadata.preview ?? {}),
          status: "ready",
          kind: "html",
          html_path: htmlPath,
          content_type: "text/html",
          generated_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", file.id)

  return html
}
