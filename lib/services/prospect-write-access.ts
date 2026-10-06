import "server-only";
import { requireOrgContext } from "@/lib/services/context";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Resolve hidden links using the server client before checking project access. */
export async function assertProspectWriteAccess(
  context: Pick<Awaited<ReturnType<typeof requireOrgContext>>, "supabase" | "orgId" | "userId">,
  prospectId: string,
  options: { reopen?: boolean } = {},
) {
  const service = createServiceSupabaseClient();
  const [{ data: prospect, error }, { data: project, error: projectError }] = await Promise.all([
    service.from("prospects").select("id, status").eq("org_id", context.orgId).eq("id", prospectId).maybeSingle(),
    service.from("projects").select("id, phase").eq("org_id", context.orgId).eq("prospect_id", prospectId).maybeSingle(),
  ]);
  if (error || projectError) throw new Error("Unable to verify deal access.");
  if (!prospect) throw new Error("Prospect not found");
  if (project) await requireAuthorization({ ...context, projectId: project.id, permission: "project.manage" });
  if (prospect.status === "won" || project?.phase === "delivery") throw new Error("This deal is in delivery. Open the project to make changes.");
  if (options.reopen ? prospect.status !== "lost" : prospect.status === "lost") {
    throw new Error(options.reopen ? "Only lost deals can be reopened." : "Reopen the deal before editing it.");
  }
}

export async function assertProspectOwner(orgId: string, ownerId?: string | null) {
  if (!ownerId) return;
  const { listTeamMembers } = await import("@/lib/services/team");
  const members = await listTeamMembers(orgId);
  if (!members.some((member) => member.status === "active" && member.user.id === ownerId)) {
    throw new Error("Choose an active team member in this organization.");
  }
}
