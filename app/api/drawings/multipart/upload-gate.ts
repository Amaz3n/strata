import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

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
}): Promise<NextResponse | null> {
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

  return null
}
