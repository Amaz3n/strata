import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileRfiDTO, MobileTeamMemberDTO } from "@/lib/mobile/contracts"
import { listProjects } from "@/lib/services/projects"

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

export async function listMobileRfis(context: MobileOrgContext, projectId: string): Promise<MobileRfiDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("rfis")
    .select(
      "id, rfi_number, subject, question, status, priority, due_date, answered_at, created_at, " +
        "assignee:app_users!rfis_assigned_to_fkey(full_name, email)",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("rfi_number", { ascending: false })
    .limit(300)
  if (error) throw new MobileAPIError(500, "rfis_unavailable", "RFIs could not be loaded.")

  return (data ?? []).map((row: any) => {
    const assignee = Array.isArray(row.assignee) ? row.assignee[0] : row.assignee
    return {
      id: row.id,
      rfi_number: row.rfi_number,
      subject: row.subject,
      question: row.question ?? null,
      status: row.status ?? "open",
      priority: row.priority ?? null,
      due_date: row.due_date ?? null,
      answered_at: row.answered_at ?? null,
      assignee_name: assignee?.full_name ?? assignee?.email ?? null,
      created_at: row.created_at,
    }
  })
}

export async function listMobileTeam(context: MobileOrgContext, projectId: string): Promise<MobileTeamMemberDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("project_members")
    .select("user_id, role:roles(label), user:app_users(full_name, email, avatar_url)")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
  if (error) throw new MobileAPIError(500, "team_unavailable", "The project team could not be loaded.")

  return (data ?? [])
    .map((row: any) => {
      const user = Array.isArray(row.user) ? row.user[0] : row.user
      const role = Array.isArray(row.role) ? row.role[0] : row.role
      return {
        id: row.user_id,
        name: user?.full_name ?? user?.email ?? "Team member",
        email: user?.email ?? null,
        role: role?.label ?? null,
        avatar_url: user?.avatar_url ?? null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
