import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import {
  requireAnyPermission,
  requirePermission,
} from "@/lib/services/permissions";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/services/audit";
import { recordEvent } from "@/lib/services/events";
import {
  EMPTY_PRECON_BRIEF,
  preconBriefSchema,
  preconDecisionSchema,
  type PreconWorkspaceRecord,
  type PreconDecision,
} from "@/lib/precon/workspace";

import { pricingWorksheetSchema } from "@/lib/precon/pricing-worksheet";

const idSchema = z.string().uuid();
const revisionSchema = z.number().int().nonnegative();

function assertOpenWorkspace(context: { prospectStatus: string; projectPhase?: string }) {
  if (context.prospectStatus === "won" || context.projectPhase === "delivery") {
    throw new Error("This deal is in delivery. Open the project to make changes.");
  }
  if (context.prospectStatus === "lost") {
    throw new Error("Reopen the deal before editing it.");
  }
}

async function workspaceContext(prospectId: string, write: boolean) {
  idSchema.parse(prospectId);
  const context = await requireOrgContext();
  if (write) await requirePermission("org.member", context);
  else await requireAnyPermission(["org.read", "org.member"], context);
  const { data: prospect, error } = await context.supabase
    .from("prospects")
    .select("id, status")
    .eq("org_id", context.orgId)
    .eq("id", prospectId)
    .maybeSingle();
  if (error) throw new Error(`Unable to load prospect: ${error.message}`);
  if (!prospect) throw new Error("Prospect not found");
  const service = createServiceSupabaseClient();
  // Resolve the link before authorization: an RLS-hidden project must not look like an unlinked lead.
  const { data: project, error: projectError } = await service
    .from("projects")
    .select("id, phase")
    .eq("org_id", context.orgId)
    .eq("prospect_id", prospectId)
    .maybeSingle();
  if (projectError)
    throw new Error(
      `Unable to load pricing workspace: ${projectError.message}`,
    );
  if (project)
    await requireAuthorization({
      ...context,
      permission: write ? "project.manage" : "project.read",
      projectId: project.id,
    });
  return {
    ...context,
    prospectStatus: prospect.status as string,
    projectId: project?.id as string | undefined,
    projectPhase: project?.phase as string | undefined,
    service,
  };
}

/** Resolve a deal's project without loading its brief or decision history. */
export async function getPreconProjectId(prospectId: string): Promise<string | null> {
  const { projectId } = await workspaceContext(prospectId, false);
  return projectId ?? null;
}

export async function getPreconWorkspace(
  prospectId: string,
): Promise<PreconWorkspaceRecord> {
  const { service, orgId } = await workspaceContext(prospectId, false);
  const [brief, decisions] = await Promise.all([
    service
      .from("precon_workspaces")
      .select("brief, version")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .maybeSingle(),
    service
      .from("precon_decisions")
      .select("*")
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .order("created_at", { ascending: false })
      .limit(501),
  ]);
  const errors = [brief.error, decisions.error].filter(Boolean);
  if (errors.length) {
    if (
      errors.every(
        (error) => error?.code === "42P01" || error?.code === "PGRST205",
      )
    ) {
      return {
        brief: EMPTY_PRECON_BRIEF,
        version: 0,
        decisions: [],
        truncated: false,
        available: false,
      };
    }
    throw new Error(
      `Unable to load preconstruction records: ${errors[0]?.message}`,
    );
  }
  const rows = decisions.data ?? [];
  return {
    pricing: brief.data?.brief?.pricing_worksheet
      ? pricingWorksheetSchema.parse(brief.data.brief.pricing_worksheet)
      : null,
    brief: brief.data
      ? preconBriefSchema.parse(brief.data.brief)
      : EMPTY_PRECON_BRIEF,
    version: brief.data?.version ?? 0,
    decisions: rows.slice(0, 500).map(
      (row): PreconDecision => ({
        ...preconDecisionSchema.parse(row),
        id: row.id,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_by: row.resolved_by,
      }),
    ),
    truncated: rows.length > 500,
    available: true,
  };
}

async function ensureOwners(orgId: string, ownerIds: Array<string | null>) {
  const ids = [...new Set(ownerIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  const { listTeamMembers } = await import("@/lib/services/team");
  const members = await listTeamMembers(orgId);
  if (
    ids.some(
      (id) =>
        !members.some(
          (member) => member.user.id === id && member.status === "active",
        ),
    )
  ) {
    throw new Error("Choose an active team member in this organization");
  }
}

export async function savePreconDecision(
  prospectId: string,
  input: unknown,
  id?: string,
  expectedVersion = 0,
) {
  const decision = preconDecisionSchema.parse(input);
  if (id) idSchema.parse(id);
  revisionSchema.parse(expectedVersion);
  const context = await workspaceContext(prospectId, true);
  assertOpenWorkspace(context);
  const { service, orgId, userId } = context;
  await ensureOwners(orgId, [decision.owner_user_id]);
  const values = {
    ...decision,
    version: expectedVersion + 1,
    updated_by: userId,
    resolved_by: decision.status === "open" ? null : userId,
  };
  const result = id
    ? await service
        .from("precon_decisions")
        .update(values)
        .eq("org_id", orgId)
        .eq("prospect_id", prospectId)
        .eq("id", id)
        .eq("version", expectedVersion)
        .select("id")
        .maybeSingle()
    : await service
        .from("precon_decisions")
        .insert({
          ...values,
          org_id: orgId,
          prospect_id: prospectId,
          created_by: userId,
        })
        .select("id")
        .single();
  if (result.error)
    throw new Error(`Unable to save decision: ${result.error.message}`);
  if (!result.data)
    throw new Error(
      "This decision changed while you were editing. Refresh and review the latest version.",
    );
  await recordAudit({
    orgId,
    actorId: userId,
    action: id ? "update" : "insert",
    entityType: "prospect",
    entityId: prospectId,
    after: { decision_id: result.data.id, ...values },
  });
  await recordEvent({
    orgId,
    actorId: userId,
    eventType: "precon_decision_updated",
    entityType: "prospect",
    entityId: prospectId,
    payload: {
      decision_id: result.data.id,
      title: decision.title,
      status: decision.status,
    },
  });
  return { id: result.data.id };
}

export async function assertPreconDecisionGate(
  prospectId: string,
  gate: "agreement" | "start",
) {
  const { service, orgId } = await workspaceContext(prospectId, false);
  const { count, error } = await service
    .from("precon_decisions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .eq("status", "open")
    .eq(gate === "agreement" ? "blocks_agreement" : "blocks_start", true);
  if (error)
    throw new Error(`Unable to verify outstanding decisions: ${error.message}`);
  if (count)
    throw new Error(
      `Resolve or explicitly accept the ${count} outstanding ${gate === "agreement" ? "agreement" : "start"} condition${count === 1 ? "" : "s"} in the preconstruction workspace first.`,
    );
}

export async function listPreconDocuments(prospectId: string) {
  const { supabase, orgId, userId, projectId } = await workspaceContext(
    prospectId,
    false,
  );
  if (!projectId) return [];
  await requirePermission("docs.read", { supabase, orgId, userId });
  const { data, error } = await supabase
    .from("files")
    .select("id, file_name, current_version_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .is("archived_at", null)
    .order("file_name")
    .limit(250);
  if (error) throw new Error("Unable to load project documents.");
  return (data ?? []).map((file) => ({
    id: file.id as string,
    name: file.file_name as string,
    version_id: (file.current_version_id ?? null) as string | null,
  }));
}

export async function authorizePreconWorkspaceRead(prospectId: string) {
  return workspaceContext(prospectId, false);
}

export async function authorizePreconWorkspaceWrite(prospectId: string) {
  return workspaceContext(prospectId, true);
}
