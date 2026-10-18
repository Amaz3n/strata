import "server-only";
import { requireOrgContext } from "@/lib/services/context";
import { requireAuthorization } from "@/lib/services/authorization";
import { hasAnyPermission, requireAnyPermission } from "@/lib/services/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * The keys that write a deal with no home linked: the Sales desk and the
 * Pipeline work the same prospects. Mirrors `arc_private.can_write_deal`.
 */
export const DEAL_WRITE_PERMISSIONS = ["sales.manage", "pipeline.write"];

type DealWriteContext = Pick<Awaited<ReturnType<typeof requireOrgContext>>, "supabase" | "orgId" | "userId">;

export async function assertCanWriteDeals(context: DealWriteContext) {
  await requireAnyPermission(DEAL_WRITE_PERMISSIONS, context);
}

export async function canWriteDeals(context: DealWriteContext) {
  return hasAnyPermission(DEAL_WRITE_PERMISSIONS, context);
}

/**
 * Resolve hidden links using the server client before checking project access.
 * A linked deal is the home's (project.manage); an unlinked one is the desks'.
 */
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
  else await assertCanWriteDeals(context);
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
