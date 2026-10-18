import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getDrawingUploadOperationForTransfer } from "@/lib/services/drawing-upload-operations"
import { hasProjectPermission } from "@/lib/services/permissions"

/**
 * Multipart follow-up calls (part-url, complete, abort) carry no projectId —
 * only the storage path minted by create, shaped
 * `${orgId}/${projectId}/drawings/uploads/...`. Re-derive the project from the
 * path and re-check drawing.upload, so a crafted path cannot drive an upload
 * lifecycle the caller was never allowed to start.
 *
 * Returns the error response to send, or null when the caller may proceed.
 */
export async function requireDrawingUploadForPath(input: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  storagePath: string
  uploadId?: string
  transferId?: string
}): Promise<NextResponse | null> {
  const segments = input.storagePath.split("/")
  if (![5, 6].includes(segments.length) || segments[0] !== input.orgId || segments[2] !== "drawings" || segments[3] !== "uploads" || !segments[4] || segments.some(segment => segment === "." || segment === "..") || input.storagePath.includes("\\")) {
    return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
  }
  const projectId = input.storagePath.split("/")[1] ?? null
  if (!projectId) {
    return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
  }

  // The project must live in the caller's org — a foreign project id in the
  // path must not authorize writes under this org's storage prefix.
  const { data: project, error } = await input.supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("org_id", input.orgId)
    .maybeSingle()
  if (error || !project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 })
  }

  if (!(await hasProjectPermission(input.userId, projectId, "drawing.upload"))) {
    return NextResponse.json({ error: "You do not have permission to upload drawings." }, { status: 403 })
  }

  if (segments.length === 6) {
    try {
      const operation = await getDrawingUploadOperationForTransfer({ operationId: segments[4], projectId, orgId: input.orgId, userId: input.userId })
      if (operation.storage_path !== input.storagePath || segments[5] !== `${operation.generation}.pdf` || !input.uploadId || operation.multipart_upload_id !== input.uploadId || !input.transferId || operation.transfer_id !== input.transferId) {
        return NextResponse.json({ error: "Upload session does not match reservation." }, { status: 409 })
      }
    } catch {
      return NextResponse.json({ error: "Upload reservation is no longer active." }, { status: 409 })
    }
  }
  return null
}

/** Local development uses authenticated streaming parts when storage CORS excludes localhost. */
export function localDrawingPartProxyUrl(request: Request, session: { storagePath: string; uploadId: string; transferId?: string }, partNumber: number): string | null {
  const url = new URL(request.url)
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".local")) return null
  url.pathname = "/api/drawings/multipart/part-proxy"
  url.search = new URLSearchParams({ storagePath: session.storagePath, uploadId: session.uploadId, transferId: session.transferId ?? "", partNumber: String(partNumber) }).toString()
  return url.toString()
}
