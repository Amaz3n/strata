import "server-only";
import { requireOrgContext } from "./context";
import { requireAuthorization } from "./authorization";
import { requirePermission } from "./permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Resolve parents with service credentials, then authorize before privileged writes. */
export async function authorizeEstimateDocumentWrite(estimateId: string, orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requirePermission("org.member", context);
  const service = createServiceSupabaseClient();
  const { data: document, error } = await service.from("estimates")
    .select("id, org_id, project_id, prospect_id, status, sent_at, updated_at, metadata, is_current_version")
    .eq("org_id", context.orgId).eq("id", estimateId).maybeSingle();
  if (error || !document) throw new Error("Estimate not found in this organization.");
  let projectId = document.project_id;
  if (document.prospect_id) {
    const [lead, linked] = await Promise.all([
      service.from("prospects").select("id,status").eq("org_id", context.orgId).eq("id", document.prospect_id).maybeSingle(),
      service.from("projects").select("id,phase").eq("org_id", context.orgId).eq("prospect_id", document.prospect_id).maybeSingle(),
    ]);
    if (lead.error || linked.error || !lead.data) throw new Error("Unable to verify the document workspace.");
    if (["won", "lost"].includes(lead.data.status)) throw new Error("Reopen this deal before changing its documents.");
    if (linked.data?.phase === "delivery") throw new Error("This deal is in delivery. Open the project to make changes.");
    if (projectId && linked.data?.id && projectId !== linked.data.id) throw new Error("The document belongs to a different project.");
    projectId = linked.data?.id ?? projectId;
  }
  await requireAuthorization({ ...context, permission: "project.manage", projectId: projectId ?? undefined,
    resourceType: "estimate", resourceId: estimateId, logDecision: true });
  return { ...context, service, document, projectId };
}
