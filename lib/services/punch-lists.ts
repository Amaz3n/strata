import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { PunchItem } from "@/lib/types"

export async function createPunchItemFromPortal({
  orgId,
  projectId,
  title,
  description,
  location,
  severity,
  portalTokenId,
}: {
  orgId: string
  projectId: string
  title: string
  description?: string
  location?: string
  severity?: string
  portalTokenId: string
}): Promise<PunchItem> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title,
      description: description ?? null,
      location: location ?? null,
      severity: severity ?? null,
      status: "open",
      created_via_portal: true,
      portal_token_id: portalTokenId,
    })
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .single()

  if (error || !data) throw new Error(`Failed to create punch item: ${error?.message}`)
  return data
}

export async function listPunchItems(orgId: string, projectId: string): Promise<PunchItem[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load punch items: ${error.message}`)
  return data ?? []
}





