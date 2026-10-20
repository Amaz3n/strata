import "server-only";
import { z } from "zod";
import { resolvePartyCapabilities } from "@/lib/directory/roles";
import type { ExternalPortalWorkspaceItem } from "@/lib/types";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { tradeJobBillingDefaults } from "@/lib/trade/workspace";
import { linkBuilderProjectSchema } from "@/lib/validation/project-connections";
import { recordAudit } from "@/lib/services/audit";
import { requireTradeContext } from "@/lib/services/business-profile";
import { requireOrgContext } from "@/lib/services/context";
import { createCompany } from "@/lib/services/companies";
import { createContact } from "@/lib/services/contacts";
import { recordEvent } from "@/lib/services/events";
import {
  getTradeBuilderWorkspace,
  openTradeBuilderConnection,
} from "@/lib/services/external-portal-auth";
import { enqueueOutboxJob } from "@/lib/services/outbox";
import {
  assignPartyRoleWithClient,
  getPartyRolesWithClient,
} from "@/lib/services/party-roles";
import { hasPermission, requirePermission } from "@/lib/services/permissions";
import { createTradeJob } from "@/lib/services/trade-workspace";

type TradeContext = Awaited<ReturnType<typeof requireTradeContext>>;

export const SYNC_CONNECTED_RECEIVABLE_JOB = "sync_connected_receivable";
const BACKFILL_PAGE = 500;
const LINK_PICKER_CAP = 200;

const statusSchema = z.enum(["active", "paused", "ended"]);
const idRow = z.object({ id: z.string() });
const connectionRow = z.object({
  id: z.string(),
  grant_id: z.string(),
  project_id: z.string(),
  source_org_id: z.string(),
  source_project_id: z.string(),
  source_company_id: z.string(),
  source_org_name: z.string(),
  source_project_name: z.string(),
  status: statusSchema,
  ended_at: z.string().nullish(),
  ended_reason: z.string().nullish(),
  last_synced_at: z.string().nullish(),
});
const CONNECTION_COLUMNS =
  "id,grant_id,project_id,source_org_id,source_project_id,source_company_id,source_org_name,source_project_name,status,ended_at,ended_reason,last_synced_at";

export interface ProjectConnection {
  id: string;
  status: z.infer<typeof statusSchema>;
  builderName: string;
  builderProjectName: string;
  endedAt: string | null;
  endedReason: string | null;
  lastSyncedAt: string | null;
  canManage: boolean;
}

function mapConnection(row: z.infer<typeof connectionRow>, canManage: boolean): ProjectConnection {
  return {
    id: row.id,
    status: row.status,
    builderName: row.source_org_name,
    builderProjectName: row.source_project_name,
    endedAt: row.ended_at ?? null,
    endedReason: row.ended_reason ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    canManage,
  };
}

/** Matches one company name exactly, ignoring case, without LIKE wildcards. */
const exactIlike = (name: string) => name.replace(/[\\%_]/g, "\\$&");

/**
 * The builder as the sub's customer: its company in the sub's directory (never
 * a second copy of one that is already there) holding a client role, and the
 * contact a job's `client_id` points at.
 */
async function ensureBuilderCustomer(context: TradeContext, builderName: string) {
  const { supabase, orgId, userId } = context;
  const existing = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .ilike("name", exactIlike(builderName))
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error("Unable to check your directory for this builder.");
  let companyId: string;
  if (existing.data) {
    companyId = idRow.parse(existing.data).id;
    const roles = await getPartyRolesWithClient(supabase, orgId, { companyIds: [companyId] });
    if (!resolvePartyCapabilities(roles.get(companyId) ?? []).isClient) {
      await assignPartyRoleWithClient(supabase, orgId, userId, {
        kind: "company",
        partyId: companyId,
        roleKey: "client",
        status: "active",
        source: "system",
      });
    }
  } else {
    companyId = (await createCompany({ input: { name: builderName, role_key: "client" } })).id;
  }
  const contact = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("primary_company_id", companyId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (contact.error) throw new Error("Unable to check your directory for this builder.");
  const contactId = contact.data
    ? idRow.parse(contact.data).id
    : (
        await createContact({
          input: { full_name: builderName, role: "Builder", role_key: "client", primary_company_id: companyId },
        })
      ).id;
  return { companyId, contactId };
}

async function requireSubGrant(grantId: string): Promise<ExternalPortalWorkspaceItem & { company_id: string }> {
  const workspace = await getTradeBuilderWorkspace();
  const item = workspace?.items.find((entry) => entry.id === grantId && entry.kind === "sub");
  if (!item) throw new Error("This invitation is no longer available. Ask the builder to check your access.");
  if (!item.company_id) throw new Error("This invitation is not tied to a company, so its invoices cannot be matched to a job.");
  return { ...item, company_id: item.company_id };
}

/** Bills the sub already submitted through the portal become receivables on the new job. */
async function enqueueBackfill(orgId: string, connectionId: string, item: { org_id: string; project_id: string; company_id: string }) {
  const service = createServiceSupabaseClient();
  let queued = 0;
  for (let from = 0; ; from += BACKFILL_PAGE) {
    const { data, error } = await service
      .from("vendor_bills")
      .select("id")
      .eq("org_id", item.org_id)
      .eq("project_id", item.project_id)
      .eq("company_id", item.company_id)
      .eq("metadata->>submitted_via_portal", "true")
      .order("id")
      .range(from, from + BACKFILL_PAGE - 1);
    if (error) return { queued, failed: true };
    const bills = z.array(idRow).parse(data ?? []);
    for (const bill of bills) {
      const result = await enqueueOutboxJob({
        orgId,
        jobType: SYNC_CONNECTED_RECEIVABLE_JOB,
        payload: { connection_id: connectionId, source_bill_id: bill.id },
        dedupeKey: `${SYNC_CONNECTED_RECEIVABLE_JOB}:${bill.id}`,
      });
      if (result.enqueued) queued += 1;
    }
    if (bills.length < BACKFILL_PAGE) return { queued, failed: false };
  }
}

/** Links a builder's shared project to a new or existing job of this company. */
export async function linkBuilderProject(rawInput: unknown) {
  const input = linkBuilderProjectSchema.parse(rawInput);
  const context = await requireTradeContext();
  await Promise.all([requirePermission("project.manage", context), requirePermission("invoice.write", context)]);
  const { supabase, orgId, userId } = context;
  const item = await requireSubGrant(input.grant_id);
  const service = createServiceSupabaseClient();

  const taken = await service
    .from("project_connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("grant_id", item.id)
    .neq("status", "ended")
    .limit(1);
  if (taken.error) throw new Error("Unable to check this invitation's link.");
  if (taken.data?.length) throw new Error("This builder project is already linked to a job.");

  let existingClientId: string | null = null;
  if (input.mode === "link") {
    const [project, linked] = await Promise.all([
      supabase.from("projects").select("id,client_id").eq("org_id", orgId).eq("id", input.project_id).maybeSingle(),
      service
        .from("project_connections")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", input.project_id)
        .neq("status", "ended")
        .limit(1),
    ]);
    if (project.error || !project.data) throw new Error("This job is not in your company workspace.");
    if (linked.error) throw new Error("Unable to check this job's link.");
    if (linked.data?.length) throw new Error("This job is already linked to a builder project.");
    existingClientId = z.object({ client_id: z.string().nullable() }).parse(project.data).client_id;
  }

  const customer = await ensureBuilderCustomer(context, item.org_name);
  let projectId: string;
  let customerKept = false;
  if (input.mode === "create") {
    projectId = (
      await createTradeJob({
        name: input.name ?? item.project_name,
        client_id: customer.contactId,
        address: item.project_address ?? "",
        property_type: input.property_type,
        customer_kind: "company",
        ...tradeJobBillingDefaults("company"),
        billing_basis: input.billing_basis,
        total_contract_value_cents: input.total_contract_value_cents,
      })
    ).id;
  } else {
    projectId = input.project_id;
    if (!existingClientId) {
      const { error } = await supabase
        .from("projects")
        .update({ client_id: customer.contactId })
        .eq("org_id", orgId)
        .eq("id", projectId);
      if (error) throw new Error("Unable to set the builder as this job's customer.");
    } else {
      customerKept = existingClientId !== customer.contactId;
    }
  }

  const inserted = await service
    .from("project_connections")
    .insert({
      org_id: orgId,
      project_id: projectId,
      grant_id: item.id,
      source_org_id: item.org_id,
      source_project_id: item.project_id,
      source_company_id: item.company_id,
      portal_access_token_id: item.token_id,
      source_org_name: item.org_name,
      source_project_name: item.project_name,
      customer_contact_id: customer.contactId,
      status: "active",
      linked_by: userId,
    })
    .select(CONNECTION_COLUMNS)
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(
      input.mode === "create"
        ? "The job was created but could not be linked. Open Builder connections and link it to this project."
        : "Unable to link this job to the builder project.",
    );
  }
  const connection = connectionRow.parse(inserted.data);

  await Promise.all([
    recordAudit({
      orgId,
      actorId: userId,
      action: "insert",
      entityType: "project_connection",
      entityId: connection.id,
      after: inserted.data,
    }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "project_connection_linked",
      entityType: "project",
      entityId: projectId,
      payload: { connection_id: connection.id, source_org_name: item.org_name, source_project_name: item.project_name },
    }),
  ]);
  const backfill = await enqueueBackfill(orgId, connection.id, item);
  return { connectionId: connection.id, projectId, customerKept, backfillQueued: backfill.queued, backfillFailed: backfill.failed };
}

/** Ends the link by hand. The job, its customer and its receivables stay. */
export async function endProjectConnection(rawConnectionId: unknown) {
  const connectionId = z.string().uuid().parse(rawConnectionId);
  const context = await requireTradeContext();
  await requirePermission("project.manage", context);
  const { supabase, orgId, userId } = context;
  const service = createServiceSupabaseClient();
  const current = await supabase
    .from("project_connections")
    .select(CONNECTION_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", connectionId)
    .maybeSingle();
  if (current.error || !current.data) throw new Error("This link is no longer available.");
  const before = connectionRow.parse(current.data);
  if (before.status === "ended") throw new Error("This link has already ended.");
  const ended = await service
    .from("project_connections")
    .update({ status: "ended", ended_at: new Date().toISOString(), ended_reason: "unlinked" })
    .eq("org_id", orgId)
    .eq("id", connectionId)
    .neq("status", "ended")
    .select(CONNECTION_COLUMNS)
    .maybeSingle();
  if (ended.error) throw new Error("Unable to unlink this job.");
  if (!ended.data) throw new Error("This link has already ended.");
  await Promise.all([
    recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "project_connection",
      entityId: connectionId,
      before,
      after: ended.data,
    }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "project_connection_ended",
      entityType: "project",
      entityId: before.project_id,
      payload: { connection_id: connectionId, reason: "unlinked" },
    }),
  ]);
  return { projectId: before.project_id };
}

export interface GrantLink {
  connectionId: string;
  grantId: string;
  projectId: string;
  projectName: string;
  status: "active" | "paused";
}

const embeddedProject = z.object({ id: z.string(), name: z.string() });
const grantLinkRow = z.object({
  id: z.string(),
  grant_id: z.string(),
  project_id: z.string(),
  status: z.enum(["active", "paused"]),
  project: z.union([embeddedProject, z.array(embeddedProject)]).nullable(),
});

/** Which of these grants already feed one of this company's jobs, and which. */
export async function listProjectConnectionsForGrants(grantIds: string[]): Promise<GrantLink[]> {
  const { supabase, orgId } = await requireTradeContext();
  if (!grantIds.length) return [];
  const { data, error } = await supabase
    .from("project_connections")
    .select("id,grant_id,project_id,status,project:projects!project_connections_project_id_fkey(id,name)")
    .eq("org_id", orgId)
    .in("grant_id", grantIds)
    .neq("status", "ended");
  if (error) throw new Error("Unable to load your linked jobs.");
  return z.array(grantLinkRow).parse(data ?? []).flatMap((row) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    return !project
      ? []
      : [{ connectionId: row.id, grantId: row.grant_id, projectId: row.project_id, projectName: project.name, status: row.status }];
  });
}

export interface LinkableJobs {
  jobs: Array<{ id: string; name: string }>;
  truncated: boolean;
}

/** Active jobs of this company with no live builder link, for the "link an existing job" picker. */
export async function listLinkableJobs(): Promise<LinkableJobs> {
  const { supabase, orgId } = await requireTradeContext();
  const [projects, links] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name", { count: "exact" })
      .eq("org_id", orgId)
      .eq("phase", "delivery")
      .not("status", "in", "(completed,cancelled)")
      .order("name")
      .order("id")
      .limit(LINK_PICKER_CAP),
    supabase.from("project_connections").select("project_id").eq("org_id", orgId).neq("status", "ended").limit(1000),
  ]);
  if (projects.error || links.error) throw new Error("Unable to load your jobs.");
  const linked = new Set(z.array(z.object({ project_id: z.string() })).parse(links.data ?? []).map((row) => row.project_id));
  const jobs = z.array(z.object({ id: z.string(), name: z.string() })).parse(projects.data ?? []);
  return {
    jobs: jobs.filter((job) => !linked.has(job.id)),
    truncated: (projects.count ?? jobs.length) > jobs.length,
  };
}

/** The builder project a job is linked to (latest link, ended ones included), for the overview. */
export async function getProjectConnection(projectId: string): Promise<ProjectConnection | null> {
  const id = z.string().uuid().parse(projectId);
  // The overview is every org's page; only a trade company's jobs have a row.
  const context = await requireOrgContext();
  const [{ data, error }, canManage] = await Promise.all([
    context.supabase
      .from("project_connections")
      .select(CONNECTION_COLUMNS)
      .eq("org_id", context.orgId)
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    hasPermission("project.manage", context),
  ]);
  if (error) throw new Error("Unable to load this job's builder project.");
  return data ? mapConnection(connectionRow.parse(data), canManage) : null;
}

/** Opens the builder's portal for a live link; the grant is resolved against the member's identity again. */
export async function openProjectConnectionPortal(rawConnectionId: unknown) {
  const connectionId = z.string().uuid().parse(rawConnectionId);
  const context = await requireTradeContext();
  await requirePermission("project.manage", context);
  const { data, error } = await context.supabase
    .from("project_connections")
    .select("grant_id,status")
    .eq("org_id", context.orgId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error || !data) throw new Error("This link is no longer available.");
  const link = z.object({ grant_id: z.string(), status: statusSchema }).parse(data);
  if (link.status !== "active") throw new Error("This builder link is not active.");
  return openTradeBuilderConnection(link.grant_id);
}
