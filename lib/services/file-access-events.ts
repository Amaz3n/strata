import { headers } from "next/headers"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  portalFileAccessLogSchema,
  type PortalFileAccessLogInput,
} from "@/lib/validation/files"

/**
 * Record a view/download from a client or sub portal.
 *
 * The portal visitor has no org membership, so this runs on the service client —
 * which is exactly why the gate lives here rather than at the call site. The
 * token is re-validated (revoked, paused, expired and PIN states all reject),
 * the org comes from the validated token rather than the request, and the file
 * must be one that token's org actually owns.
 */
export async function recordPortalFileAccess(input: PortalFileAccessLogInput): Promise<void> {
  const parsed = portalFileAccessLogSchema.parse(input)
  const access = await assertPortalActionAccess(parsed.portalToken, {
    permission: "can_view_documents",
  })

  const supabase = createServiceSupabaseClient()

  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("id")
    .eq("org_id", access.org_id)
    .eq("id", parsed.fileId)
    .maybeSingle()

  if (fileError) {
    throw new Error(`Failed to resolve file for access logging: ${fileError.message}`)
  }
  if (!file) {
    throw new Error("File not found for this portal link")
  }

  const headerStore = await headers()
  const forwardedFor = headerStore.get("x-forwarded-for") ?? ""
  const ipAddress = forwardedFor.split(",")[0]?.trim() || headerStore.get("x-real-ip") || undefined
  const userAgent = headerStore.get("user-agent") ?? undefined

  const { error } = await supabase.from("file_access_events").insert({
    org_id: access.org_id,
    file_id: parsed.fileId,
    portal_token_id: access.id,
    action: parsed.action,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata: parsed.metadata,
  })

  if (error) {
    throw new Error(`Failed to log portal file access: ${error.message}`)
  }
}
