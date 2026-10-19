import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { cache } from "react";
import { requireOrgContext } from "@/lib/services/context";
import { isProjectModelEnabled } from "@/lib/project-model-access";
import { requireAnyPermission } from "@/lib/services/permissions";
import { getDivisionScopedProjectIds } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  EMPTY_PRICING_WORKSHEET,
  pricingRowSchema,
  pricingWorksheetSchema,
  rowPricing,
  worksheetTotals,
  type PricingRow,
  type PricingWorksheet,
} from "@/lib/precon/pricing-worksheet";
import { recordEvent } from "@/lib/services/events";
import type { EstimateTemplateLine } from "@/lib/services/estimate-templates";
import {
  dealMove,
  dealValue,
  type DealBall,
  type DealDocument,
  type DealValue,
  type QuoteRequestStatus,
} from "@/lib/precon/deal-move";
import type { ProspectStatus } from "@/lib/validation/prospects";

/** The pipeline is a working list, not an archive; past this the cap is shown. */
export const PIPELINE_DEAL_CAP = 300;
/** The Won filter looks back this far; older wins live on their projects. */
const PIPELINE_WON_DAYS = 90;
const WON_SHOWN = 100;
const LOST_SHOWN = 25;
/** The proposal tab's history; older versions stay on the estimate records. */
const DOCUMENT_VERSIONS_SHOWN = 20;
const DEAL_ACTIVITY_SHOWN = 100;
/** Copy-a-deal looks through this many recent deals; a search reaches older ones. */
const PRICE_SOURCE_SCAN = 60;
const PRICE_SOURCES_SHOWN = 12;

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

type ServerSupabase = Awaited<ReturnType<typeof requireOrgContext>>["supabase"];

/** How much of the priced cost is firm, in cents; enough to draw the firmness bar. */
export type PipelineDealFirmness = {
  firm: number;
  allowance: number;
  guess: number;
  cost: number;
  firmShare: number;
  unpriced: number;
};

export type PipelineDeal = {
  id: string;
  name: string;
  clientName: string | null;
  ownerId: string | null;
  ball: DealBall;
  /** Index into `DEAL_STOPS`. */
  stop: number;
  sentence: string;
  value: DealValue;
  firmness: PipelineDealFirmness | null;
  followUpAt: string | null;
  /** When the deal last changed hands; the list ages on it. */
  waitingSince: string;
  /** The last time anyone touched the deal: an edit, the worksheet, or the client on a sent document. */
  lastActivityAt: string;
};

export type PipelineLostDeal = {
  id: string;
  name: string;
  ownerId: string | null;
  reason: string | null;
  lostAt: string | null;
};

/** A deal that became a job. It leaves the working list; the project is where it lives now. */
export type PipelineWonDeal = {
  id: string;
  name: string;
  ownerId: string | null;
  wonAt: string;
  projectId: string | null;
  /** The signed agreement's total, or the last proposal's when no agreement was priced. */
  valueCents: number | null;
};

export type PipelineDeals = {
  deals: PipelineDeal[];
  won: PipelineWonDeal[];
  /** Every win in the window, listed or not. */
  wonTotal: number;
  /** How far back the Won filter looks. */
  wonDays: number;
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
  const wonSince = new Date(Date.now() - PIPELINE_WON_DAYS * 86_400_000).toISOString();

  const [active, lostResult, scope] = await Promise.all([
    supabase
      .from("prospects")
      .select("id, name, status, owner_user_id, lost_reason, budget_range, next_follow_up_at, created_at, updated_at, won_at")
      .eq("org_id", orgId)
      // A lead for a community is a production buyer, worked on the Sales desk (`leadDesk`).
      .is("community_id", null)
      .in("status", ACTIVE_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(PIPELINE_DEAL_CAP + 1),
    supabase
      .from("prospects")
      .select("id, name, owner_user_id, lost_reason, lost_at")
      .eq("org_id", orgId)
      .is("community_id", null)
      .eq("status", "lost")
      .order("lost_at", { ascending: false, nullsFirst: false })
      .limit(LOST_SHOWN),
    getDivisionScopedProjectIds({ orgId, userId }),
  ]);
  if (active.error) throw new Error(`Unable to load the pipeline: ${active.error.message}`);
  if (lostResult.error) throw new Error(`Unable to load lost deals: ${lostResult.error.message}`);

  // Workspaces, decisions and projects are service-role tables; every read stays org-scoped.
  const service = createServiceSupabaseClient();
  const loadWins = () => recentWins(supabase, service, orgId, scope, wonSince);
  const outcome = (
    deals: PipelineDeal[],
    truncated: boolean,
    { won, total }: Awaited<ReturnType<typeof recentWins>>,
  ): PipelineDeals => ({
    deals,
    won,
    wonTotal: total,
    wonDays: PIPELINE_WON_DAYS,
    lost: mapLost(lostResult.data ?? []),
    truncated,
  });

  const truncated = (active.data?.length ?? 0) > PIPELINE_DEAL_CAP;
  const prospects = (active.data ?? []).slice(0, PIPELINE_DEAL_CAP);
  const ids = prospects.map((prospect) => prospect.id as string);
  if (!ids.length)
    return outcome([], false, await loadWins());

  const [wins, contacts, projects, documents, workspaces, questions] = await Promise.all([
    loadWins(),
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
      .select("prospect_id, updated_at, worksheet:brief->pricing_worksheet")
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

  const worksheets = new Map<string, { worksheet: PricingWorksheet | null; updatedAt: string }>();
  for (const row of workspaces.data ?? []) {
    const parsed = row.worksheet ? pricingWorksheetSchema.safeParse(row.worksheet) : null;
    worksheets.set(row.prospect_id as string, {
      worksheet: parsed?.success ? parsed.data : null,
      updatedAt: row.updated_at as string,
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
      worksheet,
      requests,
      proposal,
      agreement,
      openQuestions: openQuestions.get(id) ?? 0,
    });
    const firmness = move.firmness;
    return {
      id,
      name: prospect.name as string,
      clientName: (contact?.full_name as string | undefined) ?? null,
      ownerId: (prospect.owner_user_id as string | null) ?? null,
      ball: move.ball,
      stop: move.stop,
      sentence: move.sentence,
      value: dealValue(move, { proposal, agreement }, (prospect.budget_range as string | null) ?? null),
      firmness: firmness
        ? {
            firm: firmness.firm,
            allowance: firmness.allowance,
            guess: firmness.guess,
            cost: firmness.cost,
            firmShare: firmness.firmShare,
            unpriced: firmness.unpriced,
          }
        : null,
      followUpAt: (prospect.next_follow_up_at as string | null) ?? null,
      waitingSince: waitingSince(move.ball, {
        prospectUpdatedAt: (prospect.updated_at ?? prospect.created_at) as string,
        workspaceUpdatedAt: entry?.updatedAt ?? null,
        wonAt: (prospect.won_at as string | null) ?? null,
        document: agreement?.sent_at ? agreement : proposal,
      }),
      lastActivityAt: latest([
        (prospect.updated_at ?? prospect.created_at) as string,
        entry?.updatedAt,
        ...[proposal, agreement].flatMap((document) => [
          document?.sent_at,
          document?.viewed_at,
          document?.responded_at,
        ]),
      ]),
    };
  });
  // A deal whose job is already under way has left the pipeline, whatever its status says.
  return outcome(
    deals.filter((deal) => deal.ball !== "building"),
    truncated,
    wins,
  );
}

/** Deals won inside `PIPELINE_WON_DAYS`, newest first, with the job each became. */
async function recentWins(
  supabase: ServerSupabase,
  service: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  scope: string[] | null,
  since: string,
) {
  const result = await supabase
    .from("prospects")
    .select("id, name, owner_user_id, won_at", { count: "exact" })
    .eq("org_id", orgId)
    .is("community_id", null)
    .eq("status", "won")
    .gte("won_at", since)
    .order("won_at", { ascending: false })
    .limit(WON_SHOWN);
  if (result.error) throw new Error(`Unable to load won deals: ${result.error.message}`);
  const rows = result.data ?? [];
  const ids = rows.map((row) => row.id as string);
  if (!ids.length) return { won: [], total: 0 };

  const [projects, documents] = await Promise.all([
    service.from("projects").select("id, prospect_id").eq("org_id", orgId).in("prospect_id", ids),
    supabase
      .from("estimates")
      .select(DOCUMENT_COLUMNS)
      .eq("org_id", orgId)
      .in("prospect_id", ids)
      .eq("is_current_version", true)
      .returns<DocumentRow[]>(),
  ]);
  if (projects.error) throw new Error(`Unable to load won deals: ${projects.error.message}`);
  if (documents.error) throw new Error(`Unable to load won deals: ${documents.error.message}`);

  const projectByProspect = new Map(
    (projects.data ?? []).map((project) => [project.prospect_id as string, project.id as string]),
  );
  const won = rows
    .filter((row) => {
      const projectId = projectByProspect.get(row.id as string);
      return !scope || !projectId || scope.includes(projectId);
    })
    .map((row): PipelineWonDeal => {
      const id = row.id as string;
      const { proposal, agreement } = dealDocuments(
        (documents.data ?? []).filter((document) => document.prospect_id === id),
        null,
      );
      const valueCents = agreement?.total_cents || proposal?.total_cents || null;
      return {
        id,
        name: row.name as string,
        ownerId: (row.owner_user_id as string | null) ?? null,
        wonAt: row.won_at as string,
        projectId: projectByProspect.get(id) ?? null,
        valueCents,
      };
    });
  return { won, total: result.count ?? won.length };
}

function mapLost(rows: Array<Record<string, unknown>>): PipelineLostDeal[] {
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    ownerId: (row.owner_user_id as string | null) ?? null,
    reason: (row.lost_reason as string | null) ?? null,
    lostAt: (row.lost_at as string | null) ?? null,
  }));
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
  return latest([facts.prospectUpdatedAt, facts.workspaceUpdatedAt, facts.document?.responded_at]);
}

/** The newest of several timestamps; the first is always present. */
function latest([first, ...rest]: [string, ...Array<string | null | undefined>]) {
  return rest.reduce<string>((newest, value) => (value && value > newest ? value : newest), first);
}

/** Invitations and current quotes per request, read in two batched queries. */
export async function quoteRequestStatuses(
  supabase: ServerSupabase,
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

/** Read once per request: the deal's layout and its open tab both start from these. */
const loadProspect = cache(async (prospectId: string) => {
  const { getProspect } = await import("@/lib/services/prospects");
  return getProspect(prospectId);
});
// Authorizes access to the linked project before any pricing is read.
const loadWorkspace = cache(async (prospectId: string) => {
  const { getPreconWorkspace } = await import("@/lib/services/precon-workspace");
  return getPreconWorkspace(prospectId);
});

export type DealRoomClient = {
  name: string;
  email: string;
  phone: string;
  address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  /** The directory person behind the deal, when there is one. */
  directoryId: string | null;
};

/** What every tab of a deal shares: the header's facts, the next move's inputs and the live worksheet. */
export async function getDealRoom(prospectId: string) {
  const prospect = await loadProspect(prospectId);
  const workspace = await loadWorkspace(prospectId);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  const worksheet = workspace.pricing ?? null;
  const [{ getOrgBranding }, { getCurrentUserPermissions }, { authorize }, { listTeamMembers }, { loadDealProposal }, { loadDealPlanChanges }] = await Promise.all([
    import("@/lib/services/estimate-portal"),
    import("@/lib/services/permissions"),
    import("@/lib/services/authorization"),
    import("@/lib/services/team"),
    import("@/lib/services/precon-proposal"),
    import("@/lib/services/measurement-context"),
  ]);
  const service = createServiceSupabaseClient();
  const [documents, branding, permissions, manage, requests, members, saved, proposal, planChanges] = await Promise.all([
    supabase
      .from("estimates")
      .select(DOCUMENT_COLUMNS)
      .eq("org_id", orgId)
      .eq("prospect_id", prospectId)
      .eq("is_current_version", true)
      .returns<DocumentRow[]>(),
    getOrgBranding(orgId),
    getCurrentUserPermissions(orgId),
    prospect.project_id
      ? authorize({ supabase, orgId, userId, projectId: prospect.project_id, permission: "project.manage" })
      : Promise.resolve({ allowed: true }),
    quoteRequestStatuses(supabase, orgId, worksheet?.requests.map((request) => request.package_id) ?? []),
    listTeamMembers(orgId, { includeProjectCounts: false }),
    service.from("precon_workspaces").select("updated_at").eq("org_id", orgId).eq("prospect_id", prospectId).maybeSingle(),
    loadDealProposal({ service, orgId, prospectId, worksheet }),
    loadDealPlanChanges(prospect.project_id ?? null, worksheet),
  ]);
  if (documents.error) throw new Error(`Unable to load the deal's documents: ${documents.error.message}`);
  if (saved.error) throw new Error(`Unable to load the deal's pricing: ${saved.error.message}`);
  const granted = permissions.permissions;
  const contact = prospect.primary_contact;
  const location = prospect.jobsite_location ?? {};
  const current = dealDocuments(documents.data ?? [], worksheet);
  return {
    deal: {
      id: prospect.id,
      name: prospect.name,
      status: prospect.status,
      lostReason: prospect.lost_reason ?? null,
      projectId: prospect.project_id ?? null,
      projectPhase: prospect.project_phase ?? null,
      notes: prospect.notes ?? "",
      ownerId: prospect.owner_user_id ?? null,
      budget: prospect.budget_range ?? null,
      timeframe: prospect.timeline_preference ?? null,
      source: prospect.source ?? null,
      followUpAt: prospect.next_follow_up_at ?? null,
      createdAt: prospect.created_at,
      lastActivityAt: latest([
        prospect.updated_at ?? prospect.created_at,
        saved.data?.updated_at as string | undefined,
        ...[current.proposal, current.agreement].flatMap((document) => [
          document?.sent_at,
          document?.viewed_at,
          document?.responded_at,
        ]),
      ]),
      client: {
        name: contact?.full_name ?? "",
        email: contact?.email ?? "",
        phone: contact?.phone ?? "",
        street: location.street ?? "",
        city: location.city ?? "",
        state: location.state ?? "",
        postal_code: location.postal_code ?? "",
        address: [location.street, location.city, location.state].filter(Boolean).join(", "),
        directoryId: contact?.contact_id ?? contact?.promoted_contact_id ?? null,
      } satisfies DealRoomClient,
    },
    workspace: { worksheet, version: workspace.version, available: workspace.available },
    planChanges,
    canEdit: (granted.includes("org.member") || granted.includes("*")) && manage.allowed,
    canMeasure: (granted.includes("takeoff.write") || granted.includes("*")) && manage.allowed,
    modelEnabled: isProjectModelEnabled(orgId),
    members: members
      .filter((member) => member.status === "active")
      .map((member) => ({
        id: member.user.id,
        name: member.user.full_name || member.user.email,
        avatarUrl: member.user.avatar_url ?? null,
      })),
    currentUserId: userId,
    branding: {
      name: branding.name,
      logoUrl: branding.logoUrl,
      address: branding.address,
      estimateAccentColor: branding.estimateAccentColor,
      estimateFont: branding.estimateFont,
      estimateTermsTemplate: branding.estimateTermsTemplate,
    },
    proposal,
    proposalDefaults: branding.proposalDefaults,
    recoveryScope: `${orgId}:${userId}`,
    requests,
    documents: current,
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

export type DealRoomData = Awaited<ReturnType<typeof getDealRoom>>;

/**
 * The worksheet's supporting records: trade packages, selected quotes, the
 * company list and cost codes. Until there are lines, the templates to start from.
 */
export async function getDealPricing(prospectId: string) {
  const workspace = await loadWorkspace(prospectId);
  const { orgId } = await requireOrgContext();
  const worksheet = workspace.pricing ?? null;
  const templates = worksheet?.rows.length ? Promise.resolve([]) : listDealPriceTemplates();
  if (!worksheet) return { packages: [], quotes: [], costCodes: [], templates: await templates };
  const usesQuotes =
    worksheet.requests.some((request) => request.quote) ||
    worksheet.rows.some((row) => row.metadata.source_bid_submission_id);
  const [{ listProspectBidPackages, listProspectBidQuotes }, { listCostCodes }] = await Promise.all([
    import("@/lib/services/bids"),
    import("@/lib/services/cost-codes"),
  ]);
  const [packages, quotes, costCodes, starts] = await Promise.all([
    listProspectBidPackages(prospectId, orgId),
    usesQuotes ? listProspectBidQuotes(prospectId, orgId) : Promise.resolve([]),
    listCostCodes(orgId),
    templates,
  ]);
  return { packages, quotes, costCodes, templates: starts };
}

/** A deal shows its newest requests first; more than this is not a deal, it is a project buyout. */
const DEAL_BID_REQUESTS_SHOWN = 40;

/**
 * Everything the Bids tab works from in one pass: each request with its lines,
 * bids (every version), invitations, questions and proposal files; the plan
 * sheets and documents a request can share; and the trades it can go to.
 */
export async function getDealBids(prospectId: string) {
  const workspace = await loadWorkspace(prospectId);
  const empty = {
    requests: [],
    truncated: false,
    termsAvailable: true,
    sheets: [],
    documents: [],
    bidders: [],
    costCodes: [],
  };
  if (!workspace.pricing) return empty;
  const context = await requireOrgContext();
  const { supabase, orgId } = context;
  const [bids, { listCostCodes }, { listCompanies }, { listContacts }, { listPreconDocuments }, { listDrawingSheets }, { listBidPackageTerms }, { getCurrentUserPermissions }, { getProspect }] =
    await Promise.all([
      import("@/lib/services/bids"),
      import("@/lib/services/cost-codes"),
      import("@/lib/services/companies"),
      import("@/lib/services/contacts"),
      import("@/lib/services/precon-workspace"),
      import("@/lib/services/drawings"),
      import("@/lib/services/bid-package-terms"),
      import("@/lib/services/permissions"),
      import("@/lib/services/prospects"),
    ]);
  const [allPackages, prospect, costCodes, companies, contacts, documents, permissions] = await Promise.all([
    bids.listProspectBidPackages(prospectId, orgId),
    getProspect(prospectId),
    listCostCodes(orgId),
    listCompanies(orgId),
    listContacts(orgId),
    listPreconDocuments(prospectId),
    getCurrentUserPermissions(orgId),
  ]);
  const packages = allPackages.filter((pkg) => pkg.status !== "cancelled").slice(0, DEAL_BID_REQUESTS_SHOWN);
  const projectId = prospect?.project_id ?? null;
  const granted = permissions.permissions;
  const canReadDrawings = granted.includes("*") || granted.includes("drawing.read");
  const canReadBidHistory = granted.includes("*") || granted.includes("bid.read");
  const ids = packages.map((pkg) => pkg.id);

  const [details, terms, sheets] = await Promise.all([
    Promise.all(
      packages.map(async (pkg) => {
        const [scope, submissions, invites, rfis, files] = await Promise.all([
          bids.listBidScopeItems(pkg.id, orgId),
          bids.listBidSubmissions(pkg.id, orgId),
          bids.listBidInvites(pkg.id, orgId),
          bids.listBidPackageRfis(pkg.id, orgId),
          supabase.from("file_links").select("file_id").eq("org_id", orgId).eq("entity_type", "bid_package").eq("entity_id", pkg.id),
        ]);
        if (files.error) throw new Error(`Unable to load the request's files: ${files.error.message}`);
        const questions = await Promise.all(
          rfis
            .filter((rfi) => rfi.status !== "draft")
            .map(async (rfi) => ({
              rfi,
              answers: rfi.last_response_at ? await bids.listBidPackageRfiResponses({ rfiId: rfi.id, orgId }) : [],
            })),
        );
        return { pkg, scope, submissions, invites, questions, fileIds: (files.data ?? []).map((link) => link.file_id as string) };
      }),
    ),
    listBidPackageTerms(ids, orgId),
    projectId && canReadDrawings ? listDrawingSheets({ project_id: projectId, limit: 1000 }, orgId) : Promise.resolve([]),
  ]);

  const submissionIds = details.flatMap((detail) => detail.submissions.map((submission) => submission.id));
  const companyIds = [...new Set(details.flatMap((detail) => detail.invites.map((invite) => invite.company_id)).concat(companies.map((company) => company.id)))];
  const [proposalLinks, history] = await Promise.all([
    submissionIds.length
      ? supabase
          .from("file_links")
          .select("entity_id, file:files(id, file_name, mime_type)")
          .eq("org_id", orgId)
          .eq("entity_type", "bid_submission")
          .in("entity_id", submissionIds)
      : Promise.resolve({ data: [], error: null }),
    canReadBidHistory && companyIds.length ? (await import("@/lib/services/bid-intelligence")).getVendorBidStats(companyIds, orgId) : Promise.resolve(new Map<string, { invited_count: number; submitted_count: number }>()),
  ]);
  if (proposalLinks.error) throw new Error(`Unable to load the bidders' proposals: ${proposalLinks.error.message}`);
  const proposals = new Map<string, { id: string; name: string; mime: string | null }[]>();
  for (const link of proposalLinks.data ?? []) {
    const file = Array.isArray(link.file) ? link.file[0] : link.file;
    if (!file) continue;
    const list = proposals.get(link.entity_id as string) ?? [];
    list.push({ id: file.id as string, name: file.file_name as string, mime: (file.mime_type as string | null) ?? null });
    proposals.set(link.entity_id as string, list);
  }

  const contactsByCompany = new Map<string, { id: string; name: string; email: string }[]>();
  for (const contact of contacts) {
    if (!contact.email || !contact.primary_company_id) continue;
    const list = contactsByCompany.get(contact.primary_company_id) ?? [];
    list.push({ id: contact.id, name: contact.full_name, email: contact.email });
    contactsByCompany.set(contact.primary_company_id, list);
  }

  return {
    requests: details.map((detail) => ({
      ...detail,
      terms: terms.terms.get(detail.pkg.id) ?? { site_walk_at: null, sheet_ids: [] },
      proposals: Object.fromEntries(detail.submissions.map((submission) => [submission.id, proposals.get(submission.id) ?? []])),
    })),
    truncated: allPackages.filter((pkg) => pkg.status !== "cancelled").length > packages.length,
    termsAvailable: terms.available,
    sheets: sheets.map((sheet) => ({
      id: sheet.id,
      number: sheet.sheet_number,
      title: sheet.sheet_title ?? null,
      discipline: sheet.discipline ?? null,
    })),
    documents,
    // A bidder is a company you can reach by email: through a contact, or the company's own address.
    bidders: companies.flatMap((company) => {
      const people = contactsByCompany.get(company.id) ?? [];
      const email = people[0]?.email ?? company.email;
      if (!email) return [];
      const stats = history.get(company.id);
      return [
        {
          companyId: company.id,
          name: company.name,
          trade: company.trade ?? null,
          contactId: people[0]?.id ?? null,
          email,
          invited: stats?.invited_count ?? 0,
          answered: stats?.submitted_count ?? 0,
        },
      ];
    }),
    costCodes: costCodes.map((code) => ({ id: code.id, code: code.code, name: code.name })),
  };
}

export type DealBidsData = Awaited<ReturnType<typeof getDealBids>>;
export type DealBidRequest = DealBidsData["requests"][number];
export type DealBidder = DealBidsData["bidders"][number];

/** A plan room shows every sheet of a house; past this the cap is shown. */
export const DEAL_PLAN_SHEETS_SHOWN = 1000;

/**
 * The deal's plan room: the current set and its latest issue, every sheet
 * (with which priced lines were measured on it), which sheets the latest
 * issue changed, and the plan file from Files the builder chose to use.
 */
export async function getDealPlans(prospectId: string, projectId: string, sourceFileId?: string) {
  const [workspace, drawings, { getConditionRollup }, { hasPermission }, { getFile }] = await Promise.all([
    loadWorkspace(prospectId),
    import("@/lib/services/drawings"),
    import("@/lib/services/takeoff"),
    import("@/lib/services/permissions"),
    import("@/lib/services/files"),
  ]);
  const [sheets, total, revisions, drafts, rollups, canUpload, sourceFile] = await Promise.all([
    drawings.listDrawingSheetsWithUrls({ project_id: projectId, limit: DEAL_PLAN_SHEETS_SHOWN }),
    drawings.countDrawingSheets({ project_id: projectId }),
    drawings.listDrawingRevisions({ project_id: projectId, limit: 1 }),
    drawings.listDrawingRevisions({ project_id: projectId, status: "draft", limit: 1 }),
    getConditionRollup({ project_id: projectId }),
    hasPermission("drawing.upload"),
    sourceFileId ? getFile(sourceFileId) : Promise.resolve(null),
  ]);
  const rows = workspace.pricing?.rows ?? [];
  const rowByCondition = new Map<string, PricingRow>();
  for (const row of rows) {
    const source = (row.metadata.takeoff ?? row.metadata.takeoff_source) as { condition_id?: string } | undefined;
    if (source?.condition_id) rowByCondition.set(source.condition_id, row);
  }
  const linesBySheet = new Map<string, Set<string>>();
  for (const rollup of rollups) {
    const row = rowByCondition.get(rollup.condition.id);
    if (!row) continue;
    for (const sheet of rollup.sheets) {
      const lines = linesBySheet.get(sheet.drawing_sheet_id) ?? new Set<string>();
      lines.add(row.id);
      linesBySheet.set(sheet.drawing_sheet_id, lines);
    }
  }
  const latest = revisions[0] ?? null;
  return {
    sheets,
    truncated: total > sheets.length,
    total,
    latest: latest && {
      id: latest.id,
      label: latest.revision_label,
      issuedDate: latest.issued_date ?? latest.published_at ?? latest.created_at,
      receivedFrom: latest.received_from ?? null,
    },
    /** The sheets the latest issue replaced, so a builder sees what moved. */
    changedSheetIds: latest
      ? sheets.filter((sheet) => sheet.current_revision_id === latest.id && (sheet.version_count ?? 1) > 1).map((sheet) => sheet.id)
      : [],
    /** An upload still waiting on its review before its sheets publish. */
    draftRevisionId: drafts[0]?.id ?? null,
    measuredLines: Object.fromEntries([...linesBySheet].map(([sheetId, lines]) => [sheetId, lines.size])),
    canUpload,
    sourceFile:
      canUpload && sourceFile?.project_id === projectId && sourceFile.mime_type === "application/pdf"
        ? { id: sourceFile.id, name: sourceFile.file_name }
        : null,
  };
}

export type DealPlansData = Awaited<ReturnType<typeof getDealPlans>>;

/** What happened on the deal, newest first, capped; the cap says when it cut. */
export async function listDealActivity(prospectId: string) {
  await loadWorkspace(prospectId);
  const { listProspectActivity } = await import("@/lib/services/prospects");
  const events = await listProspectActivity(prospectId, undefined, DEAL_ACTIVITY_SHOWN + 1);
  return { activity: events.slice(0, DEAL_ACTIVITY_SHOWN), truncated: events.length > DEAL_ACTIVITY_SHOWN };
}

/** Every version the client was sent, newest first, so the proposal tab can show its history. */
export async function listDealDocumentVersions(prospectId: string) {
  await loadWorkspace(prospectId);
  const { supabase, orgId } = await requireOrgContext();
  const { data, error } = await supabase
    .from("estimates")
    .select("id, status, version, total_cents, sent_at, viewed_at, responded_at, decision_note, created_at, purpose:metadata->precon->>purpose")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .order("created_at", { ascending: false })
    .limit(DOCUMENT_VERSIONS_SHOWN + 1);
  if (error) throw new Error(`Unable to load the deal's documents: ${error.message}`);
  const rows = data ?? [];
  return {
    versions: rows.slice(0, DOCUMENT_VERSIONS_SHOWN).map((row) => ({
      id: row.id as string,
      purpose: row.purpose === "budget" ? ("budget" as const) : ("construction_agreement" as const),
      status: row.status as string,
      version: row.version as number,
      totalCents: Number(row.total_cents ?? 0),
      sentAt: (row.sent_at as string | null) ?? null,
      viewedAt: (row.viewed_at as string | null) ?? null,
      respondedAt: (row.responded_at as string | null) ?? null,
      decisionNote: (row.decision_note as string | null) ?? null,
      createdAt: row.created_at as string,
    })),
    truncated: rows.length > DOCUMENT_VERSIONS_SHOWN,
  };
}

export type DealDocumentVersion = Awaited<ReturnType<typeof listDealDocumentVersions>>["versions"][number];

/** Where a price can start: a saved template, a past deal's lines, the plans, or nothing at all. */
export type DealPriceStart =
  | { kind: "blank" }
  | { kind: "plans" }
  | { kind: "template"; templateId: string }
  | { kind: "deal"; dealId: string };

/** The org's estimate templates, by name, for the Pricing tab's starting points. */
export async function listDealPriceTemplates() {
  const { listEstimateTemplates } = await import("@/lib/services/estimate-templates");
  return (await listEstimateTemplates()).map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    lines: template.lines.filter((line) => line.item_type === "line").length,
  }));
}

/**
 * Recent deals with lines to copy, newest first. A search reaches past the
 * recent window; the list says when there were more than it shows.
 */
export async function listDealPriceSources(prospectId: string, search: string) {
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  await requireAnyPermission(["org.member"], context);
  let query = supabase
    .from("prospects")
    .select("id, name, status, updated_at")
    .eq("org_id", orgId)
    .is("community_id", null)
    .neq("id", prospectId)
    .order("updated_at", { ascending: false })
    .limit(PRICE_SOURCE_SCAN);
  const term = search.trim();
  if (term) query = query.ilike("name", `%${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`);
  const service = createServiceSupabaseClient();
  const [prospects, scope] = await Promise.all([query, getDivisionScopedProjectIds({ orgId, userId })]);
  if (prospects.error) throw new Error(`Unable to load past deals: ${prospects.error.message}`);
  const ids = (prospects.data ?? []).map((row) => row.id as string);
  if (!ids.length) return { deals: [], truncated: false };
  const [workspaces, projects] = await Promise.all([
    service
      .from("precon_workspaces")
      .select("prospect_id, first:brief->pricing_worksheet->rows->0->>id")
      .eq("org_id", orgId)
      .in("prospect_id", ids),
    service.from("projects").select("id, prospect_id").eq("org_id", orgId).in("prospect_id", ids),
  ]);
  if (workspaces.error) throw new Error(`Unable to load past deals: ${workspaces.error.message}`);
  if (projects.error) throw new Error(`Unable to load past deals: ${projects.error.message}`);
  const priced = new Set((workspaces.data ?? []).filter((row) => row.first).map((row) => row.prospect_id as string));
  const projectByProspect = new Map((projects.data ?? []).map((row) => [row.prospect_id as string, row.id as string]));
  const candidates = (prospects.data ?? []).filter((row) => {
    const project = projectByProspect.get(row.id as string);
    // Division scope is the enforcement layer: another division's prices are not offered.
    return priced.has(row.id as string) && (!scope || !project || scope.includes(project));
  });
  const shown = candidates.slice(0, PRICE_SOURCES_SHOWN);
  const sheets = shown.length
    ? await service
        .from("precon_workspaces")
        .select("prospect_id, worksheet:brief->pricing_worksheet")
        .eq("org_id", orgId)
        .in("prospect_id", shown.map((row) => row.id as string))
    : { data: [], error: null };
  if (sheets.error) throw new Error(`Unable to load past deals: ${sheets.error.message}`);
  const totals = new Map(
    (sheets.data ?? []).map((row) => {
      const parsed = pricingWorksheetSchema.safeParse(row.worksheet);
      return [
        row.prospect_id as string,
        parsed.success ? { lines: parsed.data.rows.length, cost: worksheetTotals(parsed.data).cost } : null,
      ];
    }),
  );
  return {
    deals: shown.flatMap((row) => {
      const total = totals.get(row.id as string);
      return total
        ? [{ id: row.id as string, name: row.name as string, status: row.status as ProspectStatus, updatedAt: row.updated_at as string, ...total }]
        : [];
    }),
    truncated: candidates.length > PRICE_SOURCES_SHOWN || (prospects.data?.length ?? 0) === PRICE_SOURCE_SCAN,
  };
}

export type DealPriceSource = Awaited<ReturnType<typeof listDealPriceSources>>["deals"][number];

/**
 * Starts the deal's price. Every start makes the pricing workspace; a template
 * or a past deal also lays down its lines, all as your own numbers, because a
 * quote or a measurement belongs to the job it was taken for.
 */
export async function startDealPrice(prospectId: string, start: DealPriceStart) {
  const [{ authorizePreconWorkspaceWrite, authorizePreconWorkspaceRead, getPreconWorkspace }, { startProspectPricing }, { savePricingWorksheet }] =
    await Promise.all([
      import("@/lib/services/precon-workspace"),
      import("@/lib/services/conversions"),
      import("@/lib/services/precon-pricing"),
    ]);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  if (["lost", "won"].includes(context.prospectStatus) || context.projectPhase === "delivery")
    throw new Error("Closed deals are read-only. Reopen a lost deal first.");

  const seed = await (async (): Promise<{ label: string; worksheet: PricingWorksheet | null }> => {
    switch (start.kind) {
      case "blank":
        return { label: "a blank sheet", worksheet: null };
      case "plans":
        return { label: "the plans", worksheet: null };
      case "template": {
        const { listEstimateTemplates } = await import("@/lib/services/estimate-templates");
        const template = (await listEstimateTemplates()).find((item) => item.id === start.templateId);
        if (!template) throw new Error("That template is gone. Pick another.");
        return { label: `the ${template.name} template`, worksheet: { ...EMPTY_PRICING_WORKSHEET, rows: templateRows(template.lines) } };
      }
      case "deal": {
        // Reading the source authorizes it: another division's deal cannot be copied.
        await authorizePreconWorkspaceRead(start.dealId);
        const source = (await getPreconWorkspace(start.dealId)).pricing;
        if (!source?.rows.length) throw new Error("That deal has no lines to copy.");
        const { data } = await context.service
          .from("prospects")
          .select("name")
          .eq("org_id", context.orgId)
          .eq("id", start.dealId)
          .maybeSingle();
        return { label: (data?.name as string | undefined) ?? "a past deal", worksheet: copiedWorksheet(source) };
      }
    }
  })();

  await startProspectPricing({ prospectId });
  const workspace = await getPreconWorkspace(prospectId);
  const current = workspace.pricing ?? EMPTY_PRICING_WORKSHEET;
  if (seed.worksheet) {
    if (current.rows.length) throw new Error("This deal already has lines. Add to them on the Pricing tab.");
    await savePricingWorksheet(prospectId, seed.worksheet, workspace.version);
  } else if (!workspace.pricing) {
    await savePricingWorksheet(prospectId, current, workspace.version);
  }
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "deal_price_started",
    entityType: "prospect",
    entityId: prospectId,
    payload: { from: start.kind, label: seed.label, lines: seed.worksheet?.rows.length ?? 0 },
  });
  return { lines: seed.worksheet?.rows.length ?? current.rows.length };
}

/** A template's groups become sections; each line a row at the template's number. */
function templateRows(lines: EstimateTemplateLine[]): PricingRow[] {
  let section = "";
  return lines.flatMap((line) => {
    if (line.item_type === "group") {
      section = line.description.slice(0, 200);
      return [];
    }
    return [
      pricingRowSchema.parse({
        id: randomUUID(),
        description: line.description.slice(0, 1000),
        section,
        quantity: line.quantity,
        unit: line.quantity === 1 ? "ls" : "ea",
        unit_cost_cents: line.unit_cost_cents > 0 ? line.unit_cost_cents : null,
        cost_code_id: line.cost_code_id ?? null,
        is_optional: line.is_optional ?? false,
      }),
    ];
  });
}

/** A past deal's lines, carried as your own numbers: its quotes and takeoff stay with that job. */
function copiedWorksheet(source: PricingWorksheet): PricingWorksheet {
  return {
    ...EMPTY_PRICING_WORKSHEET,
    markup_percent: source.markup_percent,
    contingency_percent: source.contingency_percent,
    tax_rate: source.tax_rate,
    rows: source.rows.map((row) => {
      const { cost } = rowPricing(row, source);
      return {
        ...row,
        id: randomUUID(),
        basis: row.basis === "allowance" ? "allowance" : "estimate",
        unit_cost_cents: cost === null ? null : row.quantity > 0 ? Math.round(cost / row.quantity) : cost,
        source: "",
        metadata: {},
      };
    }),
  };
}
