import "server-only";
import { createHash } from "node:crypto";
import { requireOrgContext } from "@/lib/services/context";
import { requireAnyPermission } from "@/lib/services/permissions";
import { getDivisionScopedProjectIds } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { pricingWorksheetSchema, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import {
  dealMove,
  type DealBall,
  type DealDocument,
  type DealMove,
  type QuoteRequestStatus,
} from "@/lib/precon/deal-move";
import type { ProspectStatus } from "@/lib/validation/prospects";

/** The pipeline is a working list, not an archive; past this the cap is shown. */
export const PIPELINE_DEAL_CAP = 300;
/** A won deal stays visible for two weeks so the team sees what just started. */
const RECENTLY_STARTED_DAYS = 14;
const LOST_SHOWN = 25;

const ACTIVE_STATUSES: ProspectStatus[] = [
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
];

export type PipelineDeal = {
  id: string;
  name: string;
  clientName: string | null;
  ball: DealBall;
  sentence: string;
  valueCents: number;
  /** When the deal last changed hands; the list ages on it. */
  waitingSince: string;
};

export type PipelineLostDeal = { id: string; name: string; reason: string | null; lostAt: string | null };

export type PipelineDeals = {
  deals: PipelineDeal[];
  lost: PipelineLostDeal[];
  truncated: boolean;
};

type DocumentRow = {
  id: string;
  prospect_id: string;
  status: string;
  version: number;
  total_cents: number | null;
  sent_at: string | null;
  viewed_at: string | null;
  responded_at: string | null;
  decision_note: string | null;
  client_signed_at: string | null;
  updated_at: string | null;
  purpose: string | null;
  fingerprint: string | null;
  accepted_total: number | null;
};

export function worksheetFingerprint(worksheet: PricingWorksheet) {
  return createHash("sha256").update(JSON.stringify(worksheet)).digest("hex");
}

/** Only the current budget and construction agreement shape the next move. */
export function dealDocuments(rows: DocumentRow[], worksheet: PricingWorksheet | null) {
  const fingerprint = worksheet ? worksheetFingerprint(worksheet) : null;
  const pick = (purpose: DealDocument["purpose"]): DealDocument | null => {
    const row = rows
      .filter((item) => (item.purpose ?? "construction_agreement") === purpose)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
    if (!row) return null;
    return {
      id: row.id,
      purpose,
      status: row.status,
      version: row.version,
      total_cents: Number(row.accepted_total ?? row.total_cents ?? 0),
      sent_at: row.sent_at,
      viewed_at: row.viewed_at,
      responded_at: row.responded_at,
      decision_note: row.decision_note,
      changed_since: Boolean(row.fingerprint && fingerprint && row.fingerprint !== fingerprint),
    };
  };
  return { proposal: pick("budget"), agreement: pick("construction_agreement") };
}

const DOCUMENT_COLUMNS =
  "id, prospect_id, status, version, total_cents, sent_at, viewed_at, responded_at, decision_note, client_signed_at, updated_at, purpose:metadata->precon->>purpose, fingerprint:metadata->pricing_worksheet->>fingerprint, accepted_total:metadata->accepted_options->>accepted_total_cents";

export async function listPipelineDeals(): Promise<PipelineDeals> {
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  await requireAnyPermission(["org.member", "org.read"], context);
  const startedSince = new Date(Date.now() - RECENTLY_STARTED_DAYS * 86_400_000).toISOString();

  const [active, lostResult, scope] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, name, status, lost_reason, notes, created_at, updated_at, won_at")
      .eq("org_id", orgId)
      // A lead for a community is a production buyer, worked on the Sales desk (`leadDesk`).
      .is("community_id", null)
      .or(`status.in.(${ACTIVE_STATUSES.join(",")}),and(status.eq.won,won_at.gte."${startedSince}")`)
      .order("updated_at", { ascending: false })
      .limit(PIPELINE_DEAL_CAP + 1),
    supabase
      .from("prospects")
      .select("id, name, lost_reason, lost_at")
      .eq("org_id", orgId)
      .is("community_id", null)
      .eq("status", "lost")
      .order("lost_at", { ascending: false, nullsFirst: false })
      .limit(LOST_SHOWN),
    getDivisionScopedProjectIds({ orgId, userId }),
  ]);
  if (active.error) throw new Error(`Unable to load the pipeline: ${active.error.message}`);
  if (lostResult.error) throw new Error(`Unable to load lost deals: ${lostResult.error.message}`);

  const truncated = (active.data?.length ?? 0) > PIPELINE_DEAL_CAP;
  const prospects = (active.data ?? []).slice(0, PIPELINE_DEAL_CAP);
  const ids = prospects.map((prospect) => prospect.id as string);
  if (!ids.length)
    return { deals: [], lost: mapLost(lostResult.data ?? []), truncated: false };

  // Workspaces and decisions are service-role tables; every read stays org-scoped.
  const service = createServiceSupabaseClient();
  const [contacts, projects, documents, workspaces, questions] = await Promise.all([
    supabase
      .from("prospect_contacts")
      .select("prospect_id, full_name, is_primary, created_at")
      .eq("org_id", orgId)
      .in("prospect_id", ids)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true }),
    service.from("projects").select("id, prospect_id, phase").eq("org_id", orgId).in("prospect_id", ids),
    supabase
      .from("estimates")
      .select(DOCUMENT_COLUMNS)
      .eq("org_id", orgId)
      .in("prospect_id", ids)
      .eq("is_current_version", true)
      .returns<DocumentRow[]>(),
    service
      .from("precon_workspaces")
      .select("prospect_id, updated_at, worksheet:brief->pricing_worksheet, target:brief->>target_budget_cents")
      .eq("org_id", orgId)
      .in("prospect_id", ids),
    service
      .from("precon_decisions")
      .select("prospect_id")
      .eq("org_id", orgId)
      .in("prospect_id", ids)
      .eq("kind", "client_decision")
      .eq("status", "open"),
  ]);
  for (const result of [contacts, projects, documents, workspaces, questions])
    if (result.error) throw new Error(`Unable to load the pipeline: ${result.error.message}`);

  const projectByProspect = new Map(
    (projects.data ?? []).map((project) => [project.prospect_id as string, project]),
  );
  const visible = prospects.filter((prospect) => {
    const project = projectByProspect.get(prospect.id as string);
    // Division scope is the enforcement layer: a deal on another division's job is not listed.
    return !scope || !project || scope.includes(project.id as string);
  });

  const worksheets = new Map<string, { worksheet: PricingWorksheet | null; updatedAt: string; target: number | null }>();
  for (const row of workspaces.data ?? []) {
    const parsed = row.worksheet ? pricingWorksheetSchema.safeParse(row.worksheet) : null;
    worksheets.set(row.prospect_id as string, {
      worksheet: parsed?.success ? parsed.data : null,
      updatedAt: row.updated_at as string,
      target: row.target ? Number(row.target) : null,
    });
  }
  const requests = await quoteRequestStatuses(
    supabase,
    orgId,
    [...worksheets.values()].flatMap((entry) => entry.worksheet?.requests.map((request) => request.package_id) ?? []),
  );
  const openQuestions = new Map<string, number>();
  for (const row of questions.data ?? [])
    openQuestions.set(row.prospect_id as string, (openQuestions.get(row.prospect_id as string) ?? 0) + 1);

  const now = new Date();
  const deals = visible.map((prospect): PipelineDeal => {
    const id = prospect.id as string;
    const entry = worksheets.get(id);
    const worksheet = entry?.worksheet ?? null;
    const { proposal, agreement } = dealDocuments(
      (documents.data ?? []).filter((row) => row.prospect_id === id),
      worksheet,
    );
    const contact = (contacts.data ?? []).find((row) => row.prospect_id === id);
    const move = dealMove({
      now,
      clientName: (contact?.full_name as string | undefined) ?? null,
      status: prospect.status as ProspectStatus,
      lostReason: (prospect.lost_reason as string | null) ?? null,
      projectPhase: (projectByProspect.get(id)?.phase as "precon" | "delivery" | undefined) ?? null,
      scope: (prospect.notes as string | null) ?? "",
      worksheet,
      requests,
      proposal,
      agreement,
      openQuestions: openQuestions.get(id) ?? 0,
    });
    return {
      id,
      name: prospect.name as string,
      clientName: (contact?.full_name as string | undefined) ?? null,
      ball: move.ball,
      sentence: move.sentence,
      valueCents: dealValue(move, proposal, agreement, entry?.target ?? null),
      waitingSince: waitingSince(move.ball, {
        prospectUpdatedAt: (prospect.updated_at ?? prospect.created_at) as string,
        workspaceUpdatedAt: entry?.updatedAt ?? null,
        wonAt: (prospect.won_at as string | null) ?? null,
        document: agreement?.sent_at ? agreement : proposal,
      }),
    };
  });
  return { deals, lost: mapLost(lostResult.data ?? []), truncated };
}

function mapLost(rows: Array<Record<string, unknown>>): PipelineLostDeal[] {
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    reason: (row.lost_reason as string | null) ?? null,
    lostAt: (row.lost_at as string | null) ?? null,
  }));
}

function dealValue(
  move: DealMove,
  proposal: DealDocument | null,
  agreement: DealDocument | null,
  target: number | null,
) {
  if (agreement && ["client_signed", "executed", "converted_to_project"].includes(agreement.status))
    return agreement.total_cents;
  if (move.firmness && move.firmness.cost > 0) return move.firmness.total;
  return agreement?.total_cents || proposal?.total_cents || target || 0;
}

function waitingSince(
  ball: DealBall,
  facts: {
    prospectUpdatedAt: string;
    workspaceUpdatedAt: string | null;
    wonAt: string | null;
    document: DealDocument | null;
  },
) {
  if (ball === "building") return facts.wonAt ?? facts.prospectUpdatedAt;
  if (ball === "client" && facts.document?.sent_at) return facts.document.sent_at;
  return [facts.prospectUpdatedAt, facts.workspaceUpdatedAt, facts.document?.responded_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) as string;
}

/** Invitations and current quotes per request, read in two batched queries. */
export async function quoteRequestStatuses(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  packageIds: string[],
): Promise<QuoteRequestStatus[]> {
  const ids = [...new Set(packageIds)];
  if (!ids.length) return [];
  const [packages, invites] = await Promise.all([
    supabase.from("bid_packages").select("id, status, due_at").eq("org_id", orgId).in("id", ids),
    supabase.from("bid_invites").select("id, bid_package_id, status").eq("org_id", orgId).in("bid_package_id", ids),
  ]);
  if (packages.error) throw new Error(`Unable to load quote requests: ${packages.error.message}`);
  if (invites.error) throw new Error(`Unable to load quote invitations: ${invites.error.message}`);
  const sent = (invites.data ?? []).filter((invite) => invite.status !== "draft");
  const submissions = sent.length
    ? await supabase
        .from("bid_submissions")
        .select("bid_invite_id")
        .eq("org_id", orgId)
        .eq("is_current", true)
        .in("bid_invite_id", sent.map((invite) => invite.id as string))
    : { data: [], error: null };
  if (submissions.error) throw new Error(`Unable to load quotes: ${submissions.error.message}`);
  const responded = new Set((submissions.data ?? []).map((row) => row.bid_invite_id as string));
  return (packages.data ?? []).map((pkg) => {
    const own = sent.filter((invite) => invite.bid_package_id === pkg.id);
    return {
      package_id: pkg.id as string,
      status: pkg.status as string,
      due_at: (pkg.due_at as string | null) ?? null,
      invite_count: own.length,
      response_count: own.filter((invite) => responded.has(invite.id as string)).length,
    };
  });
}

/** Everything the deal page renders, gathered behind the workspace's own authorization. */
export async function getDealWorkbench(prospectId: string) {
  const [{ getProspect }, { getPreconWorkspace }] = await Promise.all([
    import("@/lib/services/prospects"),
    import("@/lib/services/precon-workspace"),
  ]);
  const prospect = await getProspect(prospectId);
  if (!prospect) return null;
  // Authorizes access to the linked project before any pricing is read.
  const workspace = await getPreconWorkspace(prospectId);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  const worksheet = workspace.pricing ?? null;
  const pricingStarted = Boolean(worksheet);
  const usesQuotes = Boolean(
    worksheet &&
      (worksheet.requests.some((request) => request.quote) ||
        worksheet.rows.some((row) => row.metadata.source_bid_submission_id)),
  );
  const [
    { listProspectBidPackages, listProspectBidQuotes },
    { listCompanies },
    { listCostCodes },
    { getOrgBranding },
    { getCurrentUserPermissions },
    { authorize },
  ] = await Promise.all([
    import("@/lib/services/bids"),
    import("@/lib/services/companies"),
    import("@/lib/services/cost-codes"),
    import("@/lib/services/estimate-portal"),
    import("@/lib/services/permissions"),
    import("@/lib/services/authorization"),
  ]);
  const [documents, packages, quotes, companies, costCodes, branding, permissions, manage, requests] =
    await Promise.all([
      supabase
        .from("estimates")
        .select(DOCUMENT_COLUMNS)
        .eq("org_id", orgId)
        .eq("prospect_id", prospectId)
        .eq("is_current_version", true)
        .returns<DocumentRow[]>(),
      pricingStarted ? listProspectBidPackages(prospectId, orgId) : Promise.resolve([]),
      usesQuotes ? listProspectBidQuotes(prospectId, orgId) : Promise.resolve([]),
      pricingStarted ? listCompanies(orgId) : Promise.resolve([]),
      pricingStarted ? listCostCodes(orgId).catch(() => []) : Promise.resolve([]),
      getOrgBranding(orgId),
      getCurrentUserPermissions(orgId),
      prospect.project_id
        ? authorize({ supabase, orgId, userId, projectId: prospect.project_id, permission: "project.manage" })
        : Promise.resolve({ allowed: true }),
      quoteRequestStatuses(supabase, orgId, worksheet?.requests.map((request) => request.package_id) ?? []),
    ]);
  if (documents.error) throw new Error(`Unable to load the deal's documents: ${documents.error.message}`);
  const granted = permissions.permissions;
  const contact = prospect.primary_contact;
  const location = prospect.jobsite_location ?? {};
  return {
    deal: {
      id: prospect.id,
      name: prospect.name,
      status: prospect.status,
      lostReason: prospect.lost_reason ?? null,
      projectId: prospect.project_id ?? null,
      projectPhase: prospect.project_phase ?? null,
      notes: prospect.notes ?? "",
      client: {
        name: contact?.full_name ?? "",
        email: contact?.email ?? "",
        phone: contact?.phone ?? "",
        street: location.street ?? "",
        city: location.city ?? "",
        state: location.state ?? "",
        postal_code: location.postal_code ?? "",
        address: [location.street, location.city, location.state].filter(Boolean).join(", "),
      },
    },
    workspace: { worksheet, version: workspace.version, available: workspace.available },
    canEdit: (granted.includes("org.member") || granted.includes("*")) && manage.allowed,
    packages,
    quotes,
    companies,
    costCodes,
    branding: {
      name: branding.name,
      logoUrl: branding.logoUrl,
      address: branding.address,
      estimateAccentColor: branding.estimateAccentColor,
      estimateFont: branding.estimateFont,
      estimateTermsTemplate: branding.estimateTermsTemplate,
    },
    recoveryScope: `${orgId}:${userId}`,
    requests,
    documents: dealDocuments(documents.data ?? [], worksheet),
    questions: workspace.decisions
      .filter((decision) => decision.kind === "client_decision")
      .map((decision) => ({
        id: decision.id,
        title: decision.title,
        status: decision.status,
        resolution: decision.resolution,
        version: decision.version,
      })),
  };
}
