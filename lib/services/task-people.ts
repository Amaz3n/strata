import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { OrgServiceContext } from "@/lib/services/context"

/** Verify caller access before reading recipient membership through the service client. */
export async function taskPeople(context: OrgServiceContext, projectId?: string | null, prospectiveProject = false) {
  const { supabase, orgId } = context
  if (projectId) {
    const { data, error } = await supabase.from("projects").select("id").eq("org_id", orgId).eq("id", projectId).maybeSingle()
    if (error || !data) throw new Error("Project not found or not accessible")
  }
  const service = createServiceSupabaseClient()
  const { data: members, error } = await service.from("memberships")
    .select("user_id, app_users!memberships_user_id_fkey!inner(id, full_name, avatar_url), roles!inner(key, scope)")
    .eq("org_id", orgId).eq("status", "active")
  if (error) throw new Error(`Unable to load task recipients: ${error.message}`)
  const { data: projectMembers, error: projectError } = projectId
    ? await service.from("project_members").select("user_id").eq("org_id", orgId).eq("project_id", projectId).eq("status", "active")
    : { data: [], error: null }
  if (projectError) throw new Error(`Unable to load project recipients: ${projectError.message}`)
  const projectUsers = new Set((projectMembers ?? []).map(member => member.user_id))
  const one = <T,>(value: T | T[]) => Array.isArray(value) ? value[0] : value
  return (members ?? []).flatMap(member => {
    const role = one(member.roles), user = one(member.app_users)
    const admin = role?.scope === "org" && ["org_owner", "org_admin", "org_office_admin"].includes(role.key)
    if (!user || (projectId && !admin && !projectUsers.has(member.user_id))) return []
    if (!projectId && prospectiveProject && !admin && member.user_id !== context.userId) return []
    return [{ id: member.user_id as string, user_id: member.user_id as string, full_name: user.full_name ?? "Unknown", avatar_url: user.avatar_url ?? undefined }]
  })
}
