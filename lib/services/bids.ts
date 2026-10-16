import { assertProductionBidAccess } from "@/lib/services/production-bid-access"
import { readAllRows } from "@/lib/land/paging"
import { bidEligibilityReason, calculatePricingBasis, type BidPricingGap } from "@/lib/bids/pricing"
import { randomBytes } from "crypto"
import { hashBidToken } from "@/lib/services/portal-credentials"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { assignPartyRoleWithClient, ensureVendorRoleWithClient } from "@/lib/services/party-roles"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  selectBidForPricingInputSchema,
  createBidPackageInputSchema,
  updateBidPackageInputSchema,
  createBidInviteInputSchema,
  createBidAddendumInputSchema,
  awardBidSubmissionInputSchema,
  rescindBidAwardInputSchema,
  priceBookAwardPreviewInputSchema,
  bulkCreateBidInvitesInputSchema,
  manualBidSubmissionInputSchema,
  saveBidScopeItemsInputSchema,
  updateBidSubmissionLevelingInputSchema,
  updateBidSubmissionItemLevelingInputSchema,
  answerBidPackageRfiInputSchema,
  type BidPackageStatus,
  type BidPackageMode,
  type BidScopeItemType,
  type BidSubmissionItemResponse,
} from "@/lib/validation/bids"
import { runBidAwardConversion } from "@/lib/services/conversions"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { listRfiResponses } from "@/lib/services/rfis"
import type { Rfi, RfiResponse } from "@/lib/types"
import { getBidInvitePrequalificationWarnings } from "@/lib/services/prequalification"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import { getDivisionAccessForUser, getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { displacedByAward } from "@/lib/financials/award-displacement"
import { comparePrice, type PriceLine } from "@/lib/financials/renewal-compare"

async function getBidInviteComplianceWarnings(companyIds: string[], orgId: string): Promise<Map<string,string>> {
  const ids = Array.from(new Set(companyIds.filter(Boolean)))
  if (!ids.length) return new Map()
  try {
    const statuses = await getCompaniesComplianceStatus(ids,orgId)
    return new Map<string,string>(ids.flatMap((id): [string,string][] => {
      const status = statuses[id]
      if (!status) return [[id,"Vendor compliance could not be verified"]]
      if (status.enrollment === "unenrolled") return [[id,"Compliance is not being tracked for this vendor"]]
      if (!status.is_compliant) return [[id,"Vendor compliance is not current; review missing or expired requirements"]]
      return []
    }))
  } catch {
    return new Map(ids.map(id => [id,"Vendor compliance could not be verified"]))
  }
}

function pricingSchemaMissing(error: { code?: string } | null) {
  return !!error && ["42703", "42P01", "PGRST204", "PGRST205"].includes(error.code ?? "")
}
async function assertBidProjectVisibility(projectId: string | null | undefined, orgId: string, userId: string, supabase: any,
  productionScope?: { community_id?: string | null; house_plan_id?: string | null }) {
  if (productionScope) {
    await assertProductionBidAccess(productionScope, { supabase, orgId, userId })
    // Community/plan packages have no project; their parents define visibility.
    if (!projectId && (productionScope.community_id || productionScope.house_plan_id)) return
  }
  const ids = await getDivisionScopedProjectIds({ orgId, userId, supabase })
  if (ids && (!projectId || !ids.includes(projectId))) throw new Error("This bid package is outside your project access.")
}

export interface BidPackage {
  scope_revision?: number
  pricing_available?: boolean
  project_phase?: string | null
  can_award?: boolean
  id: string
  org_id: string
  project_id?: string | null
  prospect_id?: string | null
  community_id?: string | null
  house_plan_id?: string | null
  award_target: "commitment" | "price_agreement"
  title: string
  cost_code_id?: string | null
  budget_line_id?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  trade?: string | null
  scope?: string | null
  instructions?: string | null
  due_at?: string | null
  due_tz?: string | null
  mode: BidPackageMode
  bond_required: boolean
  status: BidPackageStatus
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  invite_count?: number
  response_count?: number
  lowest_bid_cents?: number | null
  budget_cents?: number | null
}

export interface BidScopeItem {
  id: string
  org_id: string
  bid_package_id: string
  position: number
  item_type: BidScopeItemType
  description: string
  details?: string | null
  quantity?: number | null
  unit?: string | null
  budget_cents?: number | null
  cost_code_id?: string | null
  /** Provenance jsonb — today `takeoff`, stamped by a condition sync. */
  metadata?: Record<string, any> | null
  created_at: string
  updated_at?: string | null
}

export interface BidSubmissionItem {
  id: string
  bid_submission_id: string
  bid_scope_item_id?: string | null
  description: string
  response: BidSubmissionItemResponse
  amount_cents?: number | null
  unit_rate_cents?: number | null
  quantity?: number | null
  notes?: string | null
  gc_plug_cents?: number | null
  gc_note?: string | null
}

export interface BidInvite {
  id: string
  org_id: string
  bid_package_id: string
  company_id: string
  contact_id?: string | null
  invite_email?: string | null
  status: string
  sent_at?: string | null
  last_viewed_at?: string | null
  submitted_at?: string | null
  declined_at?: string | null
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  access_total?: number
  active_access_count?: number
  paused_access_count?: number
  revoked_access_count?: number
  require_account_enforced?: boolean
  linked_account_count?: number
  linked_active_account_count?: number
  linked_paused_account_count?: number
  linked_revoked_account_count?: number
  prequalification_warning?: string
  /** Set when the bidder's insurance or paperwork is not current. */
  compliance_warning?: string
  company?: { id: string; name: string; phone?: string; email?: string }
  contact?: { id: string; full_name: string; email?: string; phone?: string }
}

export interface BidAddendum {
  id: string
  org_id: string
  bid_package_id: string
  number: number
  title?: string | null
  message?: string | null
  issued_at: string
  created_by?: string | null
}

export interface BidSubmission {
  pricing_decision?: BidPricingDecision | null
  scope_revision?: number
  id: string
  org_id: string
  bid_invite_id: string
  status: string
  version: number
  is_current: boolean
  is_awarded?: boolean
  total_cents?: number | null
  currency?: string | null
  valid_until?: string | null
  lead_time_days?: number | null
  duration_days?: number | null
  start_available_on?: string | null
  exclusions?: string | null
  clarifications?: string | null
  notes?: string | null
  submitted_by_name?: string | null
  submitted_by_email?: string | null
  submitted_at?: string | null
  source?: "portal" | "manual" | "email_ingest"
  entered_by?: string | null
  entered_at?: string | null
  leveled_adjustment_cents?: number
  leveling_notes?: string | null
  line_items?: BidSubmissionLineItem[]
  items?: BidSubmissionItem[]
  created_at: string
  invite?: BidInvite
  benchmark?: BidSubmissionBenchmark
}

export interface BidSubmissionLineItem {
  description: string
  amount_cents: number
  notes?: string | null
}

export interface BidSubmissionBenchmark {
  has_benchmark: boolean
  signal: "below_range" | "in_range" | "above_range" | "insufficient_data"
  message: string
  match_level: string
  sample_size: number
  org_count: number
  median_cents?: number | null
  p25_cents?: number | null
  p75_cents?: number | null
  submitted_total_cents?: number | null
  deviation_pct?: number | null
}

export interface BidAwardResult {
  awardId: string
  commitmentId?: string
  agreementIds?: string[]
  displacedAgreementIds?: string[]
}

export interface BidActivityItem {
  id: string
  event_type: string
  entity_type?: string | null
  entity_id?: string | null
  payload: Record<string, unknown>
  created_at: string
}

const BID_PACKAGE_COLUMNS = `id, org_id, project_id, prospect_id, community_id, house_plan_id, award_target, title, cost_code_id, budget_line_id, trade, scope, instructions, due_at, due_tz, mode, bond_required, status, created_by, created_at, updated_at`

function mapBidPackage(row: any): BidPackage {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? null,
    prospect_id: row.prospect_id ?? null,
    community_id: row.community_id ?? null,
    house_plan_id: row.house_plan_id ?? null,
    scope_revision: row.scope_revision ?? 1,
    award_target: row.award_target === "price_agreement" ? "price_agreement" : "commitment",
    title: row.title,
    cost_code_id: row.cost_code_id ?? null,
    budget_line_id: row.budget_line_id ?? null,
    cost_code_code: row.cost_code?.code ?? null,
    cost_code_name: row.cost_code?.name ?? null,
    trade: row.trade ?? null,
    scope: row.scope ?? null,
    instructions: row.instructions ?? null,
    due_at: row.due_at ?? null,
    due_tz: row.due_tz ?? null,
    mode: (row.mode as BidPackageMode) ?? "quote",
    bond_required: !!row.bond_required,
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    invite_count: (row.bid_invites as any)?.[0]?.count ?? undefined,
    response_count: row.response_count != null ? Number(row.response_count) : undefined,
    lowest_bid_cents: row.lowest_bid_cents ?? null,
    budget_cents: row.budget_cents ?? null,
  }
}

function mapBidInvite(row: any): BidInvite {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_package_id: row.bid_package_id,
    company_id: row.company_id,
    contact_id: row.contact_id ?? null,
    invite_email: row.invite_email ?? null,
    status: row.status,
    sent_at: row.sent_at ?? null,
    last_viewed_at: row.last_viewed_at ?? null,
    submitted_at: row.submitted_at ?? null,
    declined_at: row.declined_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    prequalification_warning: row.prequalification_warning ?? undefined,
    compliance_warning: row.compliance_warning ?? undefined,
    access_total: row.access_total ?? undefined,
    active_access_count: row.active_access_count ?? undefined,
    paused_access_count: row.paused_access_count ?? undefined,
    revoked_access_count: row.revoked_access_count ?? undefined,
    company: row.company
      ? {
          id: row.company.id,
          name: row.company.name,
          phone: row.company.phone ?? undefined,
          email: row.company.email ?? undefined,
        }
      : undefined,
    contact: row.contact
      ? {
          id: row.contact.id,
          full_name: row.contact.full_name,
          email: row.contact.email ?? undefined,
          phone: row.contact.phone ?? undefined,
        }
      : undefined,
  }
}

function mapBidAddendum(row: any): BidAddendum {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_package_id: row.bid_package_id,
    number: row.number,
    title: row.title ?? null,
    message: row.message ?? null,
    issued_at: row.issued_at,
    created_by: row.created_by ?? null,
  }
}

function mapBidSubmission(row: any): BidSubmission {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_invite_id: row.bid_invite_id,
    status: row.status,
    version: row.version,
    is_current: row.is_current,
    scope_revision: row.scope_revision ?? 1,
    is_awarded: row.is_awarded ?? false,
    total_cents: row.total_cents ?? null,
    currency: row.currency ?? null,
    valid_until: row.valid_until ?? null,
    lead_time_days: row.lead_time_days ?? null,
    duration_days: row.duration_days ?? null,
    start_available_on: row.start_available_on ?? null,
    exclusions: row.exclusions ?? null,
    clarifications: row.clarifications ?? null,
    notes: row.notes ?? null,
    submitted_by_name: row.submitted_by_name ?? null,
    submitted_by_email: row.submitted_by_email ?? null,
    submitted_at: row.submitted_at ?? null,
    source: row.source ?? "portal",
    entered_by: row.entered_by ?? null,
    entered_at: row.entered_at ?? null,
    leveled_adjustment_cents: Number(row.leveled_adjustment_cents ?? 0),
    leveling_notes: row.leveling_notes ?? null,
    line_items: Array.isArray(row.line_items) ? row.line_items : [],
    items: Array.isArray(row.items) ? row.items.map(mapBidSubmissionItem) : undefined,
    created_at: row.created_at,
    invite: row.bid_invite ? mapBidInvite(row.bid_invite) : undefined,
    benchmark: row.benchmark ? mapBidSubmissionBenchmark(row.benchmark) : undefined,
  }
}

function mapBidSubmissionItem(row: any): BidSubmissionItem {
  return {
    id: row.id,
    bid_submission_id: row.bid_submission_id,
    bid_scope_item_id: row.bid_scope_item_id ?? null,
    description: row.description,
    response: (row.response as BidSubmissionItemResponse) ?? "priced",
    amount_cents: row.amount_cents != null ? Number(row.amount_cents) : null,
    unit_rate_cents: row.unit_rate_cents != null ? Number(row.unit_rate_cents) : null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
    notes: row.notes ?? null,
    gc_plug_cents: row.gc_plug_cents != null ? Number(row.gc_plug_cents) : null,
    gc_note: row.gc_note ?? null,
  }
}

function mapBidScopeItem(row: any): BidScopeItem {
  return {
    id: row.id,
    org_id: row.org_id,
    bid_package_id: row.bid_package_id,
    position: Number(row.position ?? 0),
    item_type: (row.item_type as BidScopeItemType) ?? "base",
    description: row.description,
    details: row.details ?? null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
    unit: row.unit ?? null,
    budget_cents: row.budget_cents != null ? Number(row.budget_cents) : null,
    cost_code_id: row.cost_code_id ?? null,
    metadata: row.metadata ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  }
}

function mapBidSubmissionBenchmark(row: any): BidSubmissionBenchmark {
  return {
    has_benchmark: !!row.has_benchmark,
    signal: (row.signal ?? "insufficient_data") as BidSubmissionBenchmark["signal"],
    message: row.message ?? "Benchmark unavailable.",
    match_level: row.match_level ?? "none",
    sample_size: Number(row.sample_size ?? 0),
    org_count: Number(row.org_count ?? 0),
    median_cents: row.median_cents ?? null,
    p25_cents: row.p25_cents ?? null,
    p75_cents: row.p75_cents ?? null,
    submitted_total_cents: row.submitted_total_cents ?? null,
    deviation_pct: row.deviation_pct != null ? Number(row.deviation_pct) : null,
  }
}

function getAppUrl() {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_URL ||
    ""
  if (!url) return ""
  if (url.startsWith("http")) return url.replace(/\/$/, "")
  return `https://${url}`.replace(/\/$/, "")
}

async function enqueueBidEmail(
  orgId: string,
  payload: Record<string, unknown>,
  dedupeByPayloadKeys: string[] = [],
) {
  return enqueueOutboxJob({
    orgId,
    jobType: "send_bid_email",
    payload,
    dedupeByPayloadKeys,
  })
}

async function createBidInviteLink({
  supabase,
  orgId,
  userId,
  inviteId,
  markSent,
  revokeExisting = true,
}: {
  supabase: any
  orgId: string
  userId?: string | null
  inviteId: string
  markSent: boolean
  revokeExisting?: boolean
}): Promise<{ url: string; token: string }> {

  const now = new Date().toISOString()
  const token = randomBytes(32).toString("hex")
  const tokenHash = hashBidToken(token)

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id, status")
    .eq("org_id", orgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  await ensureBidPackageInOrg(invite.bid_package_id, orgId, supabase)

  if (revokeExisting) {
    const { error: revokeError } = await supabase
      .from("bid_access_tokens")
      .update({ revoked_at: now })
      .eq("org_id", orgId)
      .eq("bid_invite_id", inviteId)
      .is("revoked_at", null)
    if (revokeError) {
      throw new Error(`Failed to rotate existing bid links: ${revokeError.message}`)
    }
  }

  const { error } = await supabase
    .from("bid_access_tokens")
    .insert({
      org_id: orgId,
      bid_invite_id: inviteId,
      token_hash: tokenHash,
      require_account: false,
      created_by: userId ?? null,
    })

  if (error) {
    throw new Error(`Failed to generate bid link: ${error.message}`)
  }

  if (markSent && invite.status === "draft") {
    await supabase
      .from("bid_invites")
      .update({ status: "sent", sent_at: now })
      .eq("org_id", orgId)
      .eq("id", inviteId)
  }

  const appUrl = getAppUrl()
  return { url: `${appUrl}/b/${token}`, token }
}

type BidEmailOrg = { name?: string | null; logo_url?: string | null; slug?: string | null } | null

/** The "you're invited to bid" email — one payload for first send and resend. */
async function enqueueBidInviteEmail({
  orgId,
  to,
  invite,
  bidPackage,
  jobName,
  org,
  bidLink,
  resentBy,
}: {
  orgId: string
  to: string
  invite: BidInvite
  bidPackage: { id: string; title: string; trade?: string | null; due_at?: string | null }
  jobName: string | undefined
  org: BidEmailOrg
  bidLink: string
  resentBy?: string
}) {
  const queued = await enqueueBidEmail(orgId, {
    kind: "invite",
    to,
    companyName: invite.company?.name,
    contactName: invite.contact?.full_name,
    projectName: jobName,
    bidPackageTitle: bidPackage.title,
    trade: bidPackage.trade ?? null,
    dueDate: bidPackage.due_at ?? null,
    orgName: org?.name,
    orgLogoUrl: org?.logo_url,
    bidLink,
    orgSlug: org?.slug,
    bidPackageId: bidPackage.id,
    inviteId: invite.id,
    ...(resentBy ? { resentBy } : {}),
  })
  if (!queued.enqueued) throw new Error("The invite email could not be queued")
  return queued
}

function getBidEmailRecipient(invite: BidInvite) {
  return invite.invite_email || invite.contact?.email || invite.company?.email || null
}

async function resolveBidPackageJobName(supabase: any, orgId: string, bidPackage: { project_id?: string | null; prospect_id?: string | null; community_id?: string | null; house_plan_id?: string | null }) {
  if (bidPackage.project_id) {
    const { data: project } = await supabase
      .from("projects")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("id", bidPackage.project_id)
      .maybeSingle()
    return project?.name as string | undefined
  }

  if (bidPackage.prospect_id) {
    const { data: prospect } = await supabase
      .from("prospects")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("id", bidPackage.prospect_id)
      .maybeSingle()
    return prospect?.name as string | undefined
  }

  if (bidPackage.community_id || bidPackage.house_plan_id) {
    const [communityResult, planResult] = await Promise.all([
      bidPackage.community_id
        ? supabase.from("communities").select("name").eq("org_id", orgId).eq("id", bidPackage.community_id).maybeSingle()
        : Promise.resolve({ data: null }),
      bidPackage.house_plan_id
        ? supabase.from("house_plans").select("name").eq("org_id", orgId).eq("id", bidPackage.house_plan_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    return [communityResult.data?.name, planResult.data?.name].filter(Boolean).join(" — ") || "Price book"
  }

  return undefined
}

async function resolveLatestBudgetForBidPackage({
  supabase,
  orgId,
  projectId,
  costCodeId,
  budgetLineId,
}: {
  supabase: any
  orgId: string
  projectId?: string | null
  costCodeId?: string | null
  budgetLineId?: string | null
}) {
  if (!projectId || (!costCodeId && !budgetLineId)) return null

  if (budgetLineId) {
    const { data: line } = await supabase
      .from("budget_lines")
      .select("amount_cents, budget:budgets!inner(project_id)")
      .eq("org_id", orgId)
      .eq("id", budgetLineId)
      .eq("budget.project_id", projectId)
      .maybeSingle()

    if (line?.amount_cents != null) return Number(line.amount_cents)
  }

  if (!costCodeId) return null

  const { data: budget } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!budget?.id) return null

  const { data: lines } = await supabase
    .from("budget_lines")
    .select("amount_cents")
    .eq("org_id", orgId)
    .eq("budget_id", budget.id)
    .eq("cost_code_id", costCodeId)

  const total = (lines ?? []).reduce((sum: number, line: any) => sum + Number(line.amount_cents ?? 0), 0)
  return total > 0 ? total : null
}

async function resolveBudgetLineForCostCode({
  supabase,
  orgId,
  projectId,
  costCodeId,
}: {
  supabase: any
  orgId: string
  projectId?: string | null
  costCodeId?: string | null
}) {
  if (!projectId || !costCodeId) return null

  const { data: budget } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!budget?.id) return null

  const { data: line } = await supabase
    .from("budget_lines")
    .select("id, cost_code_id")
    .eq("org_id", orgId)
    .eq("budget_id", budget.id)
    .eq("cost_code_id", costCodeId)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle()

  return line ?? null
}

async function decorateBidPackageSummaries(supabase: any, orgId: string, packages: BidPackage[]) {
  if (packages.length === 0) return packages
  const packageIds = packages.map((pkg) => pkg.id)

  const { data: inviteRows } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id")
    .eq("org_id", orgId)
    .in("bid_package_id", packageIds)

  const inviteIds = (inviteRows ?? []).map((row: any) => row.id as string)
  const inviteToPackage = new Map<string, string>((inviteRows ?? []).map((row: any) => [row.id as string, row.bid_package_id as string]))
  const responseCountByPackage = new Map<string, number>()
  const lowestByPackage = new Map<string, number>()

  if (inviteIds.length > 0) {
    const { data: submissionRows } = await supabase
      .from("bid_submissions")
      .select("bid_invite_id, total_cents")
      .eq("org_id", orgId)
      .eq("is_current", true)
      .in("bid_invite_id", inviteIds)

    for (const row of submissionRows ?? []) {
      const packageId = inviteToPackage.get(row.bid_invite_id as string)
      if (!packageId) continue
      responseCountByPackage.set(packageId, (responseCountByPackage.get(packageId) ?? 0) + 1)
      if (row.total_cents != null) {
        const currentLowest = lowestByPackage.get(packageId)
        const amount = Number(row.total_cents)
        if (currentLowest == null || amount < currentLowest) {
          lowestByPackage.set(packageId, amount)
        }
      }
    }
  }

  const budgetByPackage = await resolveBudgetsForBidPackages(supabase, orgId, packages)

  return packages.map((pkg) => ({
    ...pkg,
    response_count: responseCountByPackage.get(pkg.id) ?? 0,
    lowest_bid_cents: lowestByPackage.get(pkg.id) ?? null,
    budget_cents: budgetByPackage.get(pkg.id) ?? null,
  }))
}

/** Batched budget resolution for a package list: one query for mapped budget
 * lines, one for each project's latest budget, one for cost-code sums —
 * regardless of package count. */
async function resolveBudgetsForBidPackages(
  supabase: any,
  orgId: string,
  packages: BidPackage[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()

  const budgetLineIds = [
    ...new Set(
      packages
        .filter((pkg) => pkg.project_id && pkg.budget_line_id)
        .map((pkg) => pkg.budget_line_id as string),
    ),
  ]
  const lineAmountById = new Map<string, { amount: number; projectId: string | null }>()
  if (budgetLineIds.length > 0) {
    const { data: lines } = await supabase
      .from("budget_lines")
      .select("id, amount_cents, budget:budgets!inner(project_id)")
      .eq("org_id", orgId)
      .in("id", budgetLineIds)
    for (const line of lines ?? []) {
      const budget = Array.isArray(line.budget) ? line.budget[0] : line.budget
      lineAmountById.set(line.id as string, {
        amount: Number(line.amount_cents ?? 0),
        projectId: (budget?.project_id as string | undefined) ?? null,
      })
    }
  }

  const costCodeFallbacks = packages.filter(
    (pkg) =>
      pkg.project_id &&
      pkg.cost_code_id &&
      !(pkg.budget_line_id && lineAmountById.has(pkg.budget_line_id)),
  )
  const fallbackProjectIds = [...new Set(costCodeFallbacks.map((pkg) => pkg.project_id as string))]
  const latestBudgetByProject = new Map<string, string>()
  const costCodeSums = new Map<string, number>()
  if (fallbackProjectIds.length > 0) {
    const { data: budgets } = await supabase
      .from("budgets")
      .select("id, project_id, version")
      .eq("org_id", orgId)
      .in("project_id", fallbackProjectIds)
      .order("version", { ascending: false })
    for (const budget of budgets ?? []) {
      if (!latestBudgetByProject.has(budget.project_id as string)) {
        latestBudgetByProject.set(budget.project_id as string, budget.id as string)
      }
    }

    const latestBudgetIds = [...latestBudgetByProject.values()]
    const costCodeIds = [...new Set(costCodeFallbacks.map((pkg) => pkg.cost_code_id as string))]
    if (latestBudgetIds.length > 0 && costCodeIds.length > 0) {
      const { data: lines } = await supabase
        .from("budget_lines")
        .select("budget_id, cost_code_id, amount_cents")
        .eq("org_id", orgId)
        .in("budget_id", latestBudgetIds)
        .in("cost_code_id", costCodeIds)
      for (const line of lines ?? []) {
        const key = `${line.budget_id}:${line.cost_code_id}`
        costCodeSums.set(key, (costCodeSums.get(key) ?? 0) + Number(line.amount_cents ?? 0))
      }
    }
  }

  for (const pkg of packages) {
    if (!pkg.project_id) continue
    if (pkg.budget_line_id) {
      const line = lineAmountById.get(pkg.budget_line_id)
      if (line && line.projectId === pkg.project_id) {
        result.set(pkg.id, line.amount)
        continue
      }
    }
    if (pkg.cost_code_id) {
      const budgetId = latestBudgetByProject.get(pkg.project_id)
      if (budgetId) {
        const sum = costCodeSums.get(`${budgetId}:${pkg.cost_code_id}`)
        if (sum != null && sum > 0) result.set(pkg.id, sum)
      }
    }
  }

  return result
}

export interface ProjectBuyoutStatus {
  project_id: string
  total_packages: number
  open_packages: number
  awarded_packages: number
  draft_packages: number
  budget_line_ids: string[]
  cost_code_ids: string[]
  by_budget_line_id: Record<
    string,
    {
      package_count: number
      awarded_count: number
      open_count: number
      lowest_bid_cents?: number | null
    }
  >
  by_cost_code_id: Record<
    string,
    {
      package_count: number
      awarded_count: number
      open_count: number
      lowest_bid_cents?: number | null
    }
  >
}

export async function getProjectBuyoutStatus(projectId: string, orgId?: string): Promise<ProjectBuyoutStatus> {
  const packages = await listBidPackages(projectId, orgId)
  const byBudgetLineId: ProjectBuyoutStatus["by_budget_line_id"] = {}
  const byCostCodeId: ProjectBuyoutStatus["by_cost_code_id"] = {}

  for (const pkg of packages) {
    const statusBucket = {
      package_count: 1,
      awarded_count: pkg.status === "awarded" ? 1 : 0,
      open_count: pkg.status === "sent" || pkg.status === "open" ? 1 : 0,
      lowest_bid_cents: pkg.lowest_bid_cents ?? null,
    }

    if (pkg.budget_line_id) {
      const current = byBudgetLineId[pkg.budget_line_id] ?? {
        package_count: 0,
        awarded_count: 0,
        open_count: 0,
        lowest_bid_cents: null,
      }
      byBudgetLineId[pkg.budget_line_id] = {
        package_count: current.package_count + statusBucket.package_count,
        awarded_count: current.awarded_count + statusBucket.awarded_count,
        open_count: current.open_count + statusBucket.open_count,
        lowest_bid_cents:
          current.lowest_bid_cents == null
            ? statusBucket.lowest_bid_cents
            : statusBucket.lowest_bid_cents == null
              ? current.lowest_bid_cents
              : Math.min(current.lowest_bid_cents, statusBucket.lowest_bid_cents),
      }
    }

    if (pkg.cost_code_id) {
      const current = byCostCodeId[pkg.cost_code_id] ?? {
        package_count: 0,
        awarded_count: 0,
        open_count: 0,
        lowest_bid_cents: null,
      }
      byCostCodeId[pkg.cost_code_id] = {
        package_count: current.package_count + statusBucket.package_count,
        awarded_count: current.awarded_count + statusBucket.awarded_count,
        open_count: current.open_count + statusBucket.open_count,
        lowest_bid_cents:
          current.lowest_bid_cents == null
            ? statusBucket.lowest_bid_cents
            : statusBucket.lowest_bid_cents == null
              ? current.lowest_bid_cents
              : Math.min(current.lowest_bid_cents, statusBucket.lowest_bid_cents),
      }
    }
  }

  return {
    project_id: projectId,
    total_packages: packages.length,
    open_packages: packages.filter((pkg) => pkg.status === "sent" || pkg.status === "open").length,
    awarded_packages: packages.filter((pkg) => pkg.status === "awarded").length,
    draft_packages: packages.filter((pkg) => pkg.status === "draft").length,
    budget_line_ids: Object.keys(byBudgetLineId),
    cost_code_ids: Object.keys(byCostCodeId),
    by_budget_line_id: byBudgetLineId,
    by_cost_code_id: byCostCodeId,
  }
}

/** Legal package status transitions. Awarding and rescinding move status via
 * their own RPCs; the free-form update path only walks this graph. */
const BID_PACKAGE_TRANSITIONS: Record<BidPackageStatus, BidPackageStatus[]> = {
  draft: ["sent", "open", "cancelled"],
  sent: ["open", "closed", "cancelled"],
  open: ["closed", "cancelled"],
  closed: ["open", "cancelled"],
  awarded: [],
  cancelled: ["draft"],
}

function assertBidPackageTransition(from: BidPackageStatus, to: BidPackageStatus) {
  if (from === to) return
  if (!BID_PACKAGE_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`A ${from} bid package cannot move to ${to}`)
  }
}

async function ensureProjectBiddingStatus(projectId: string, orgId: string, supabase: any) {
  const { data: project } = await supabase
    .from("projects")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  if (project?.status === "planning") {
    await supabase
      .from("projects")
      .update({ status: "bidding" })
      .eq("org_id", orgId)
      .eq("id", projectId)
  }
}

/** Side effects of a package status move: a project starts bidding once a
 * package goes out, and every real move is an event. */
async function recordBidPackageStatusChange({
  supabase,
  orgId,
  userId,
  bidPackageId,
  projectId,
  from,
  to,
}: {
  supabase: any
  orgId: string
  userId: string
  bidPackageId: string
  projectId: string | null | undefined
  from: BidPackageStatus
  to: BidPackageStatus
}) {
  if ((to === "sent" || to === "open") && projectId) {
    await ensureProjectBiddingStatus(projectId, orgId, supabase)
  }
  if (from === to) return
  await recordEvent({
    orgId,
    actorId: userId,
    eventType: "bid_package_status_changed",
    entityType: "bid_package",
    entityId: bidPackageId,
    payload: { from, to },
  })
}

async function ensureProjectInOrg(projectId: string, orgId: string, supabase: any) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, prospect_id")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (error || !project) {
    throw new Error("Project not found in this organization")
  }
  return project
}

async function ensureProspectInOrg(prospectId: string, orgId: string, supabase: any) {
  const { data: prospect, error } = await supabase
    .from("prospects")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", prospectId)
    .maybeSingle()
  if (error || !prospect) {
    throw new Error("Prospect not found in this organization")
  }
  return prospect
}

async function ensureBidPackageInOrg(bidPackageId: string, orgId: string, supabase: any) {
  const { data: bidPackage, error } = await supabase
    .from("bid_packages")
    .select("id, project_id, prospect_id, community_id, house_plan_id, cost_code_id, budget_line_id")
    .eq("org_id", orgId)
    .eq("id", bidPackageId)
    .maybeSingle()
  if (error || !bidPackage) {
    throw new Error("Bid package not found in this organization")
  }
  const { userId } = await requireOrgContext(orgId)
  await assertBidProjectVisibility(bidPackage.project_id, orgId, userId, supabase, bidPackage)
  return bidPackage
}

async function ensureBidInviteAccess(inviteId: string, orgId: string, supabase: any) {
  const { data, error } = await supabase.from("bid_invites").select("id,bid_package_id")
    .eq("org_id", orgId).eq("id", inviteId).maybeSingle()
  if (error || !data) throw new Error("Bid invite not found")
  await ensureBidPackageInOrg(data.bid_package_id, orgId, supabase)
  return data
}

async function ensureBidSubmissionAccess(submissionId: string, orgId: string, supabase: any) {
  const { data, error } = await supabase.from("bid_submissions").select("id,bid_invite_id")
    .eq("org_id", orgId).eq("id", submissionId).maybeSingle()
  if (error || !data) throw new Error("Bid submission not found")
  await ensureBidInviteAccess(data.bid_invite_id, orgId, supabase)
  return data
}

async function ensureCostCodeInOrg(costCodeId: string, orgId: string, supabase: any) {
  const { data: costCode, error } = await supabase
    .from("cost_codes")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", costCodeId)
    .maybeSingle()
  if (error || !costCode) {
    throw new Error("Cost code not found in this organization")
  }
}

async function ensureBudgetLineInProject(budgetLineId: string, projectId: string, orgId: string, supabase: any) {
  const { data: budgetLine, error } = await supabase
    .from("budget_lines")
    .select("id, cost_code_id, budget:budgets!inner(project_id)")
    .eq("org_id", orgId)
    .eq("id", budgetLineId)
    .eq("budget.project_id", projectId)
    .maybeSingle()

  if (error || !budgetLine) {
    throw new Error("Budget line not found for this project")
  }

  return budgetLine
}

async function ensureCompanyInOrg(companyId: string, orgId: string, supabase: any) {
  const { data: company, error } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", companyId)
    .maybeSingle()
  if (error || !company) {
    throw new Error("Company not found in this organization")
  }
}

async function ensureContactInOrg(contactId: string, orgId: string, supabase: any) {
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", contactId)
    .maybeSingle()
  if (error || !contact) {
    throw new Error("Contact not found in this organization")
  }
}

export async function listBidPackages(projectId: string, orgId?: string): Promise<BidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  await ensureProjectInOrg(projectId, resolvedOrgId, supabase)
  await assertBidProjectVisibility(projectId, resolvedOrgId, userId, supabase)

  const { data, error } = await supabase
    .from("bid_packages")
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name),
      bid_invites!bid_invites_org_package_fk(count)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid packages: ${error.message}`)
  }

  return decorateBidPackageSummaries(supabase, resolvedOrgId, (data ?? []).map(mapBidPackage))
}

export interface BuyoutSummaryRow {
  bid_package_id: string
  title: string
  cost_code_code: string | null
  company_name: string | null
  budget_cents: number | null
  awarded_total_cents: number | null
  commitment_id: string | null
  commitment_status: string | null
  executed_at: string | null
  out_for_signature: boolean
}

/**
 * Per-package buyout status for a project: what was budgeted, what it was
 * awarded for, and how far the subcontract has progressed (approved → out for
 * signature → executed). Only awarded packages appear.
 */
export async function getProjectBuyoutSummary(projectId: string, orgId?: string): Promise<BuyoutSummaryRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureProjectInOrg(projectId, resolvedOrgId, supabase)
  await assertBidProjectVisibility(projectId, resolvedOrgId, userId, supabase)

  const { data: packages, error: packagesError } = await supabase
    .from("bid_packages")
    .select("id, title, cost_code_id, budget_line_id, cost_code:cost_codes(code)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("status", "awarded")

  if (packagesError) {
    throw new Error(`Failed to load buyout packages: ${packagesError.message}`)
  }
  if (!packages || packages.length === 0) return []

  const packageIds = packages.map((row: any) => row.id as string)

  const { data: awards, error: awardsError } = await supabase
    .from("bid_awards")
    .select("bid_package_id, awarded_commitment_id")
    .eq("org_id", resolvedOrgId)
    .in("bid_package_id", packageIds)

  if (awardsError) {
    throw new Error(`Failed to load bid awards: ${awardsError.message}`)
  }

  const commitmentIds = (awards ?? [])
    .map((award: any) => award.awarded_commitment_id as string | null)
    .filter((id: string | null): id is string => Boolean(id))

  const commitmentById = new Map<string, any>()
  const envelopeCommitmentIds = new Set<string>()
  if (commitmentIds.length > 0) {
    const [commitmentsResult, envelopesResult] = await Promise.all([
      supabase
        .from("commitments")
        .select("id, status, total_cents, executed_at, company:companies(name)")
        .eq("org_id", resolvedOrgId)
        .in("id", commitmentIds),
      supabase
        .from("envelopes")
        .select("source_entity_id, status")
        .eq("org_id", resolvedOrgId)
        .eq("source_entity_type", "subcontract")
        .in("source_entity_id", commitmentIds)
        .not("status", "in", '("draft","voided")'),
    ])

    if (commitmentsResult.error) {
      throw new Error(`Failed to load buyout commitments: ${commitmentsResult.error.message}`)
    }
    for (const row of commitmentsResult.data ?? []) {
      commitmentById.set(row.id as string, row)
    }
    for (const row of envelopesResult.data ?? []) {
      if (row.source_entity_id) envelopeCommitmentIds.add(row.source_entity_id as string)
    }
  }

  // Budget amounts come from the mapped budget line when the package has one.
  const budgetLineIds = packages
    .map((row: any) => row.budget_line_id as string | null)
    .filter((id: string | null): id is string => Boolean(id))
  const budgetAmountByLine = new Map<string, number>()
  if (budgetLineIds.length > 0) {
    const { data: budgetLines, error: budgetError } = await supabase
      .from("budget_lines")
      .select("id, amount_cents")
      .eq("org_id", resolvedOrgId)
      .in("id", budgetLineIds)
    if (budgetError) {
      throw new Error(`Failed to load buyout budget lines: ${budgetError.message}`)
    }
    for (const row of budgetLines ?? []) {
      budgetAmountByLine.set(row.id as string, row.amount_cents ?? 0)
    }
  }

  const awardByPackage = new Map<string, string | null>()
  for (const award of awards ?? []) {
    awardByPackage.set(award.bid_package_id as string, (award.awarded_commitment_id as string | null) ?? null)
  }

  return packages.map((row: any) => {
    const commitmentId = awardByPackage.get(row.id) ?? null
    const commitment = commitmentId ? commitmentById.get(commitmentId) : null
    return {
      bid_package_id: row.id as string,
      title: row.title as string,
      cost_code_code: (row.cost_code?.code as string | undefined) ?? null,
      company_name: (commitment?.company?.name as string | undefined) ?? null,
      budget_cents: row.budget_line_id ? (budgetAmountByLine.get(row.budget_line_id) ?? null) : null,
      awarded_total_cents: (commitment?.total_cents as number | undefined) ?? null,
      commitment_id: commitmentId,
      commitment_status: (commitment?.status as string | undefined) ?? null,
      executed_at: (commitment?.executed_at as string | undefined) ?? null,
      out_for_signature: commitmentId ? envelopeCommitmentIds.has(commitmentId) : false,
    }
  })
}

export interface ProspectBidQuote {
  submission_id: string
  bid_package_id: string
  package_title: string
  trade: string | null
  company_name: string | null
  total_cents: number
  normalized_total_cents: number
  pricing_decision_id: string | null
  submission_version: number
  selected_for_pricing: boolean
  valid_until: string | null
  scope_revision: number
  accepted_alternate_ids: string[]
  gaps: BidPricingGap[]
}
export interface BidPricingDecision {
  id: string; bid_package_id: string; bid_submission_id: string; submission_version: number; scope_revision: number
  vendor_total_cents: number; normalized_total_cents: number; accepted_alternate_ids: string[]; gaps: BidPricingGap[]
  rationale: string; selected_at: string; snapshot: Record<string, unknown>; eligibility_reason?: string | null
}
async function prospectBidPackageFilter(supabase: any, orgId: string, prospectId: string) {
  const { data: project, error } = await supabase.from("projects").select("id")
    .eq("org_id", orgId).eq("prospect_id", prospectId).maybeSingle()
  if (error) throw new Error(`Unable to find the linked project: ${error.message}`)
  return project ? `prospect_id.eq.${prospectId},project_id.eq.${project.id}` : `prospect_id.eq.${prospectId}`
}
/** Include both pre-project requests and requests on the linked precon project. */
export async function listProspectBidPackages(prospectId: string, orgId?: string): Promise<BidPackage[]> {
  const { supabase, orgId: id, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: id, userId })
  await ensureProspectInOrg(prospectId, id, supabase)
  const filter = await prospectBidPackageFilter(supabase, id, prospectId)
  const { data, error } = await supabase.from("bid_packages").select(`${BID_PACKAGE_COLUMNS}, cost_code:cost_codes(code, name)`)
    .eq("org_id", id).or(filter).order("created_at", { ascending: false })
  if (error) throw new Error(`Unable to load quote requests: ${error.message}`)
  for (const projectId of new Set((data ?? []).map(row => row.project_id).filter(Boolean))) {
    await assertBidProjectVisibility(projectId, id, userId, supabase)
  }
  return decorateBidPackageSummaries(supabase, id, (data ?? []).map(mapBidPackage))
}
export async function listProspectPricingDecisions(prospectId: string, orgId?: string): Promise<BidPricingDecision[]> {
  const { supabase, orgId: id, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: id, userId })
  await ensureProspectInOrg(prospectId, id, supabase)
  const parentFilter = await prospectBidPackageFilter(supabase, id, prospectId)
  const { data: packages, error } = await supabase.from("bid_packages").select("id,project_id").eq("org_id", id).or(parentFilter)
  if (error) throw new Error(error.message)
  if (!packages?.length) return []
  const allowedProjects = await getDivisionScopedProjectIds({orgId:id,userId,supabase})
  const visiblePackages = packages.filter(pkg => !allowedProjects || (pkg.project_id && allowedProjects.includes(pkg.project_id)))
  if (!visiblePackages.length) return []
  const result = await createServiceSupabaseClient().from("bid_pricing_decisions").select("*").eq("org_id", id).in("bid_package_id", visiblePackages.map(p => p.id)).is("superseded_at", null)
  if (result.error && pricingSchemaMissing(result.error)) return []
  if (result.error) throw new Error(result.error.message)
  const decisions = result.data as BidPricingDecision[]
  if (!decisions.length) return []
  const { data: offers, error: offerError } = await supabase.from("bid_submissions").select("id,is_current,status,total_cents,valid_until,scope_revision").eq("org_id",id).in("id",decisions.map(d=>d.bid_submission_id))
  if(offerError) throw new Error(offerError.message)
  return decisions.map(decision=>{const offer=offers?.find(row=>row.id===decision.bid_submission_id);return {...decision,eligibility_reason:offer?bidEligibilityReason(offer,decision.scope_revision):"Quote unavailable"}})
}
export async function listProspectBidQuotes(prospectId: string, orgId?: string): Promise<ProspectBidQuote[]> {
  const { supabase, orgId: id, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: id, userId })
  await ensureProspectInOrg(prospectId, id, supabase)
  const parentFilter = await prospectBidPackageFilter(supabase, id, prospectId)
  const { data: packages, error } = await supabase.from("bid_packages").select("id,title,trade,scope_revision").eq("org_id", id).or(parentFilter).neq("status", "cancelled")
  if (error && pricingSchemaMissing(error)) return []
  if (error) throw new Error(error.message)
  const decisions = await listProspectPricingDecisions(prospectId, id)
  const rows = await Promise.all((packages ?? []).map(async pkg => {
    const [bids, scope] = await Promise.all([listBidSubmissions(pkg.id, id), listBidScopeItems(pkg.id, id)])
    return bids.filter(bid => !bidEligibilityReason(bid, pkg.scope_revision)).map(bid => {
      const decision = decisions.find(d => d.bid_submission_id === bid.id && d.scope_revision === pkg.scope_revision)
      const plugs = (bid.items ?? []).filter(i => i.response !== "priced" && scope.find(s => s.id === i.bid_scope_item_id)?.item_type !== "alternate").reduce((sum, i) => sum + (i.gc_plug_cents ?? 0), 0)
      return { submission_id: bid.id, bid_package_id: pkg.id, package_title: pkg.title, trade: pkg.trade, company_name: bid.invite?.company?.name ?? null,
        total_cents: bid.total_cents!, normalized_total_cents: decision?.normalized_total_cents ?? bid.total_cents! + plugs + (bid.leveled_adjustment_cents ?? 0),
        pricing_decision_id: decision?.id ?? null, submission_version: bid.version, selected_for_pricing: !!decision,
        valid_until: bid.valid_until ?? null, scope_revision: pkg.scope_revision, accepted_alternate_ids: decision?.accepted_alternate_ids ?? [], gaps: decision?.gaps ?? [] }
    })
  }))
  return rows.flat().filter(row => row.selected_for_pricing).sort((a,b) => Number(b.selected_for_pricing)-Number(a.selected_for_pricing) || a.package_title.localeCompare(b.package_title))
}
export async function selectBidForPricing({ input, orgId }: { input: unknown; orgId?: string }) {
  const parsed = selectBidForPricingInputSchema.parse(input)
  const { supabase, orgId: id, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: id, userId })
  const { data: row, error } = await supabase.from("bid_submissions").select("bid_invite_id").eq("org_id",id).eq("id",parsed.bid_submission_id).single()
  if (error) throw new Error(error.message)
  const { data: invite, error: inviteError } = await supabase.from("bid_invites").select("bid_package_id").eq("org_id",id).eq("id",row.bid_invite_id).single()
  if (inviteError) throw new Error(inviteError.message)
  const [pkg,bids,scope] = await Promise.all([getBidPackage(invite.bid_package_id,id),listBidSubmissions(invite.bid_package_id,id),listBidScopeItems(invite.bid_package_id,id)])
  const bid = bids.find(b => b.id === parsed.bid_submission_id)
  if (!bid) throw new Error("Quote not found")
  if (pkg.status === "draft") throw new Error("Issue the package before selecting a pricing basis.")
  const reason = bidEligibilityReason(bid,pkg.scope_revision)
  if (reason) throw new Error(reason)
  if (bid.exclusions?.trim() && !parsed.gaps.some(gap => gap.scope_item_id === "quote-exclusions")) throw new Error("Resolve the vendor's written exclusions before selecting the quote.")
  const totals = calculatePricingBasis(bid,scope,parsed.accepted_alternate_ids,parsed.gaps)
  const result = await createServiceSupabaseClient().rpc("save_bid_pricing_decision", { p_org_id:id,p_submission_id:bid.id,p_user_id:userId,p_data:{ ...parsed,...totals,snapshot:{ submission:bid,scope,package:pkg } } })
  if (result.error) throw new Error(pricingSchemaMissing(result.error) || result.error.code === "PGRST202" ? "Pricing decisions require the pending preconstruction database migration." : result.error.message)
  return { id: result.data as string, ...totals }
}
export async function beginBidScopeRevision({ bidPackageId, reason, orgId }: { bidPackageId: string; reason: string; orgId?: string }) {
  const { supabase, orgId: id, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: id, userId })
  const pkg = await ensureBidPackageInOrg(bidPackageId,id,supabase)
  await assertBidProjectVisibility(pkg.project_id,id,userId,supabase,pkg)
  const result = await createServiceSupabaseClient().rpc("begin_bid_scope_revision", {p_org_id:id,p_package_id:bidPackageId,p_reason:reason})
  if(result.error) throw new Error(pricingSchemaMissing(result.error) || result.error.code === "PGRST202" ? "Scope revisions require the pending preconstruction database migration." : result.error.message)
  return result.data as number
}

/**
 * Whether a preconstruction job has its signed owner contract and commercial award.
 * project_precon_handoffs is service-role only (no grant to authenticated), so the
 * caller's client can never read it; callers authorize and scope the project first.
 */
async function hasOwnerAward(orgId: string, projectId: string): Promise<boolean> {
  const { data, error } = await createServiceSupabaseClient().from("project_precon_handoffs")
    .select("id,contract:contracts!inner(status)").eq("contract.status", "active")
    .eq("org_id", orgId).eq("project_id", projectId)
    .in("status", ["awarded", "baseline_approved", "accepted", "released"]).maybeSingle()
  if (error) throw new Error(`Unable to verify owner award: ${error.message}`)
  return Boolean(data)
}

export async function getBidPackage(bidPackageId: string, orgId?: string): Promise<BidPackage> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_packages")
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .single()

  if (error || !data) {
    throw new Error("Bid package not found")
  }

  const mapped = mapBidPackage(data)
  await assertBidProjectVisibility(mapped.project_id, resolvedOrgId, userId, supabase, mapped)
  const revisionResult = await supabase.from("bid_packages").select("scope_revision").eq("org_id",resolvedOrgId).eq("id",bidPackageId).maybeSingle()
  if (revisionResult.error && !pricingSchemaMissing(revisionResult.error)) throw new Error(revisionResult.error.message)
  mapped.scope_revision = revisionResult.data?.scope_revision ?? 1
  mapped.pricing_available = !revisionResult.error
  if (mapped.project_id) {
    const { data: project } = await supabase.from("projects").select("phase").eq("org_id", resolvedOrgId).eq("id", mapped.project_id).maybeSingle()
    mapped.project_phase = project?.phase ?? null
    mapped.can_award = project?.phase !== "precon"
    if (project?.phase === "precon") {
      mapped.can_award = await hasOwnerAward(resolvedOrgId, mapped.project_id).catch(() => false)
    }
  }
  mapped.budget_cents = await resolveLatestBudgetForBidPackage({
    supabase,
    orgId: resolvedOrgId,
    projectId: mapped.project_id,
    costCodeId: mapped.cost_code_id,
    budgetLineId: mapped.budget_line_id,
  })
  return mapped
}

/** A bid package decorated with the name of the job it belongs to (a live
 * project or a pipeline prospect) — used by the org-wide Bid Day desk. */
export interface OrgBidPackage extends BidPackage {
  job_name: string | null
  job_kind: "project" | "prospect" | "community_plan" | null
}

/**
 * Every non-cancelled bid package across the org, decorated with invite /
 * response counts + lowest bid and the name of its job (project or prospect).
 * Ordered by due date (nulls last) and capped — this powers the read-only
 * org Bid Day desk, so it never mutates anything.
 */
export async function listOrgBidPackages(orgId?: string, divisionId?: string): Promise<OrgBidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  const [authorizedProjectIds, divisionAccess] = await Promise.all([
    getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase }),
    getDivisionAccessForUser({ orgId: resolvedOrgId, userId }),
  ])
  const divisionIds = divisionId
    ? (!divisionAccess.assignedOnly || divisionAccess.divisionIds.includes(divisionId) ? [divisionId] : [])
    : divisionAccess.assignedOnly
      ? divisionAccess.divisionIds
      : null
  const { data: scopedCommunities, error: communitiesError } = divisionIds
    ? await supabase.from("communities").select("id").eq("org_id", resolvedOrgId).in("division_id", divisionIds.length ? divisionIds : ["00000000-0000-0000-0000-000000000000"])
    : { data: null, error: null }
  const { data: scopedProjects, error: projectsError } = divisionIds
    ? await supabase.from("projects").select("id").eq("org_id", resolvedOrgId).in("division_id", divisionIds.length ? divisionIds : ["00000000-0000-0000-0000-000000000000"])
    : { data: null, error: null }
  if (communitiesError || projectsError) throw new Error("Failed to load bid scope")
  const allowedCommunities = scopedCommunities ? new Set(scopedCommunities.map((row) => row.id)) : null
  const lensProjectIds = scopedProjects ? new Set(scopedProjects.map((row) => row.id)) : null
  const allowedProjects = authorizedProjectIds
    ? new Set(authorizedProjectIds.filter((id) => !lensProjectIds || lensProjectIds.has(id)))
    : lensProjectIds

  const result = await readAllRows<any>((from, to) => {
    let query = supabase.from("bid_packages").select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name),
      bid_invites!bid_invites_org_package_fk(count)
    `).eq("org_id", resolvedOrgId).neq("status", "cancelled")
    // Scope the source before paging. Null-scoped packages remain visible,
    // matching the existing organization/prospect package rules.
    if (allowedProjects) {
      query = allowedProjects.size
        ? query.or(`project_id.is.null,project_id.in.(${[...allowedProjects].join(",")})`)
        : query.is("project_id", null)
    }
    if (allowedCommunities) {
      query = allowedCommunities.size
        ? query.or(`community_id.is.null,community_id.in.(${[...allowedCommunities].join(",")})`)
        : query.is("community_id", null)
    }
    return query.order("due_at", { ascending: true, nullsFirst: false }).order("id").range(from, to)
  }, { cap: 10_000, label: "Failed to list bid packages" })
  if (result.truncated) throw new Error("Too many bid packages. Select a division to narrow the list.")
  const scopedPackages = result.rows.map(mapBidPackage)
  const packages = await decorateBidPackageSummaries(supabase, resolvedOrgId, scopedPackages)

  const projectIds = [...new Set(packages.map((pkg) => pkg.project_id).filter((id): id is string => Boolean(id)))]
  const prospectIds = [...new Set(packages.map((pkg) => pkg.prospect_id).filter((id): id is string => Boolean(id)))]
  const communityIds = [...new Set(packages.map((pkg) => pkg.community_id).filter((id): id is string => Boolean(id)))]
  const planIds = [...new Set(packages.map((pkg) => pkg.house_plan_id).filter((id): id is string => Boolean(id)))]

  const [projectRows, prospectRows, communityRows, planRows] = await Promise.all([
    projectIds.length > 0
      ? supabase.from("projects").select("id, name").eq("org_id", resolvedOrgId).in("id", projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    prospectIds.length > 0
      ? supabase.from("prospects").select("id, name").eq("org_id", resolvedOrgId).in("id", prospectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    communityIds.length > 0
      ? supabase.from("communities").select("id, name").eq("org_id", resolvedOrgId).in("id", communityIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    planIds.length > 0
      ? supabase.from("house_plans").select("id, name").eq("org_id", resolvedOrgId).in("id", planIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])

  const projectNameById = new Map((projectRows.data ?? []).map((row: any) => [row.id as string, row.name as string]))
  const prospectNameById = new Map((prospectRows.data ?? []).map((row: any) => [row.id as string, row.name as string]))
  const communityNameById = new Map((communityRows.data ?? []).map((row: any) => [row.id as string, row.name as string]))
  const planNameById = new Map((planRows.data ?? []).map((row: any) => [row.id as string, row.name as string]))

  return packages.map((pkg) => {
    const job_kind: OrgBidPackage["job_kind"] = pkg.project_id ? "project" : pkg.prospect_id ? "prospect" : (pkg.community_id || pkg.house_plan_id) ? "community_plan" : null
    const job_name = pkg.project_id
      ? projectNameById.get(pkg.project_id) ?? null
      : pkg.prospect_id
        ? prospectNameById.get(pkg.prospect_id) ?? null
        : (pkg.community_id || pkg.house_plan_id)
          ? [pkg.community_id ? communityNameById.get(pkg.community_id) : null, pkg.house_plan_id ? planNameById.get(pkg.house_plan_id) : null].filter(Boolean).join(" — ") || "Price book"
          : null
    return { ...pkg, job_name, job_kind }
  })
}

export async function listBidScopeItems(bidPackageId: string, orgId?: string): Promise<BidScopeItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_scope_items")
    .select("id, org_id, bid_package_id, position, item_type, description, details, quantity, unit, budget_cents, cost_code_id, metadata, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .order("position", { ascending: true })

  if (error) {
    throw new Error(`Failed to list bid scope items: ${error.message}`)
  }

  return (data ?? []).map(mapBidScopeItem)
}

/** Replace-style save of a package's scope schedule: rows with ids update,
 * rows without insert, missing rows delete. Submission items keep their
 * description snapshot when a scope line is removed (FK sets null). */
export async function saveBidScopeItems({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidScopeItem[]> {
  const parsed = saveBidScopeItemsInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  const pkg = await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  const { data: pkgStatusRow } = await supabase
    .from("bid_packages")
    .select("status")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_package_id)
    .maybeSingle()
  if (pkgStatusRow?.status !== "draft") {
    throw new Error("Issued scope is locked. Start a scope revision before editing.")
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("bid_scope_items")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", parsed.bid_package_id)
  if (existingError) {
    throw new Error(`Failed to load existing scope items: ${existingError.message}`)
  }

  const keptIds = new Set(parsed.items.map((item) => item.id).filter(Boolean) as string[])
  const removedIds = (existingRows ?? []).map((row: any) => row.id as string).filter((id) => !keptIds.has(id))

  const now = new Date().toISOString()
  const upserts = parsed.items.map((item, index) => ({
    ...(item.id ? { id: item.id } : {}),
    org_id: resolvedOrgId,
    bid_package_id: parsed.bid_package_id,
    position: index,
    item_type: item.item_type,
    description: item.description,
    details: item.details ?? null,
    quantity: item.quantity ?? null,
    unit: item.unit ?? null,
    budget_cents: item.budget_cents ?? null,
    cost_code_id: item.cost_code_id ?? null,
    created_by: userId,
    updated_at: now,
  }))

  if (removedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("bid_scope_items")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", parsed.bid_package_id)
      .in("id", removedIds)
    if (deleteError) {
      throw new Error(`Failed to remove scope items: ${deleteError.message}`)
    }
  }

  if (upserts.length > 0) {
    const { error: upsertError } = await supabase
      .from("bid_scope_items")
      .upsert(upserts, { onConflict: "id" })
    if (upsertError) {
      throw new Error(`Failed to save scope items: ${upsertError.message}`)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_scope_updated",
    entityType: "bid_package",
    entityId: parsed.bid_package_id,
    payload: {
      bid_package_id: parsed.bid_package_id,
      item_count: parsed.items.length,
      removed_count: removedIds.length,
      project_id: pkg.project_id ?? null,
      prospect_id: pkg.prospect_id ?? null,
    },
  })

  return listBidScopeItems(parsed.bid_package_id, resolvedOrgId)
}

export async function createBidPackage({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidPackage> {
  const parsed = createBidPackageInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  if (parsed.project_id) {
    await ensureProjectInOrg(parsed.project_id, resolvedOrgId, supabase)
  }
  if (parsed.prospect_id) {
    await ensureProspectInOrg(parsed.prospect_id, resolvedOrgId, supabase)
  }
  await assertProductionBidAccess(parsed, { supabase, orgId: resolvedOrgId, userId })
  if (parsed.community_id) {
    const { data } = await supabase.from("communities").select("id").eq("org_id", resolvedOrgId).eq("id", parsed.community_id).maybeSingle()
    if (!data) throw new Error("Community not found")
  }
  if (parsed.house_plan_id) {
    const { data } = await supabase.from("house_plans").select("id").eq("org_id", resolvedOrgId).eq("id", parsed.house_plan_id).maybeSingle()
    if (!data) throw new Error("House plan not found")
  }
  if (parsed.cost_code_id) {
    await ensureCostCodeInOrg(parsed.cost_code_id, resolvedOrgId, supabase)
  }
  // A package has one parent. Resolve prospect work to its linked project;
  // quote lookups follow projects.prospect_id instead of duplicating ownership.
  let resolvedProjectId = parsed.project_id ?? null
  let resolvedProspectId = parsed.prospect_id ?? null
  if (!resolvedProjectId && resolvedProspectId) {
    const { data: project, error } = await supabase.from("projects").select("id")
      .eq("org_id", resolvedOrgId).eq("prospect_id", resolvedProspectId).maybeSingle()
    if (error) throw new Error(`Unable to find the linked project: ${error.message}`)
    resolvedProjectId = project?.id ?? null
  }
  if (resolvedProjectId) resolvedProspectId = null

  let resolvedCostCodeId = parsed.cost_code_id ?? null
  if (parsed.budget_line_id) {
    if (!parsed.project_id) {
      throw new Error("Budget line links require a project bid package")
    }
    const budgetLine = await ensureBudgetLineInProject(parsed.budget_line_id, parsed.project_id, resolvedOrgId, supabase)
    if (resolvedCostCodeId && budgetLine.cost_code_id && resolvedCostCodeId !== budgetLine.cost_code_id) {
      throw new Error("Budget line cost code does not match the selected cost code")
    }
    resolvedCostCodeId = resolvedCostCodeId ?? budgetLine.cost_code_id ?? null
  }

  const { data, error } = await supabase
    .from("bid_packages")
    .insert({
      org_id: resolvedOrgId,
      project_id: resolvedProjectId,
      prospect_id: resolvedProspectId,
      community_id: parsed.community_id ?? null,
      house_plan_id: parsed.house_plan_id ?? null,
      award_target: parsed.project_id || parsed.prospect_id ? "commitment" : "price_agreement",
      title: parsed.title,
      cost_code_id: resolvedCostCodeId,
      budget_line_id: parsed.budget_line_id ?? null,
      trade: parsed.trade ?? null,
      scope: parsed.scope ?? null,
      instructions: parsed.instructions ?? null,
      due_at: parsed.due_at ?? null,
      due_tz: parsed.due_tz ?? null,
      mode: parsed.mode ?? "quote",
      bond_required: parsed.bond_required ?? false,
      status: parsed.status ?? "draft",
      created_by: userId,
    })
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create bid package: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_package_created",
    entityType: "bid_package",
    entityId: data.id as string,
    payload: { title: data.title, project_id: parsed.project_id ?? null, prospect_id: parsed.prospect_id ?? null, community_id: parsed.community_id ?? null, house_plan_id: parsed.house_plan_id ?? null },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_package",
    entityId: data.id as string,
    after: data,
  })

  return mapBidPackage(data)
}

export async function updateBidPackage({
  bidPackageId,
  input,
  orgId,
}: {
  bidPackageId: string
  input: unknown
  orgId?: string
}): Promise<BidPackage> {
  const parsed = updateBidPackageInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("bid_packages")
    .select("id, org_id, project_id, prospect_id, community_id, house_plan_id, award_target, status, due_at, title, cost_code_id, budget_line_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Bid package not found")
  }

  await assertProductionBidAccess(existing, { supabase, orgId: resolvedOrgId, userId })
  await assertProductionBidAccess({ community_id: parsed.community_id === undefined ? existing.community_id : parsed.community_id, house_plan_id: parsed.house_plan_id === undefined ? existing.house_plan_id : parsed.house_plan_id }, { supabase, orgId: resolvedOrgId, userId })

  if (existing.status !== "draft" && (parsed.scope !== undefined || parsed.instructions !== undefined || parsed.mode !== undefined)) {
    throw new Error("Start a scope revision before changing an issued package's scope or instructions.")
  }
  const changesParent = (parsed.community_id !== undefined && parsed.community_id !== existing.community_id)
    || (parsed.house_plan_id !== undefined && parsed.house_plan_id !== existing.house_plan_id)
    || (parsed.cost_code_id !== undefined && parsed.cost_code_id !== existing.cost_code_id)
  if (existing.status !== "draft" && changesParent) {
    throw new Error("An issued bid package keeps its community, plan and cost code.")
  }
  const isDueDateUpdated = parsed.due_at !== undefined && parsed.due_at !== existing.due_at

  if (parsed.cost_code_id) {
    await ensureCostCodeInOrg(parsed.cost_code_id, resolvedOrgId, supabase)
  }
  let resolvedUpdateCostCodeId =
    parsed.cost_code_id !== undefined ? parsed.cost_code_id : undefined
  if (parsed.budget_line_id) {
    if (!existing.project_id) {
      throw new Error("Budget line links require a project bid package")
    }
    const budgetLine = await ensureBudgetLineInProject(parsed.budget_line_id, existing.project_id, resolvedOrgId, supabase)
    if (resolvedUpdateCostCodeId && budgetLine.cost_code_id && resolvedUpdateCostCodeId !== budgetLine.cost_code_id) {
      throw new Error("Budget line cost code does not match the selected cost code")
    }
    resolvedUpdateCostCodeId = resolvedUpdateCostCodeId ?? budgetLine.cost_code_id ?? undefined
  }

  const updates: Record<string, any> = {
    updated_at: new Date().toISOString(),
  }
  if (parsed.title !== undefined) updates.title = parsed.title
  if (parsed.community_id !== undefined) updates.community_id = parsed.community_id
  if (parsed.house_plan_id !== undefined) updates.house_plan_id = parsed.house_plan_id
  if (resolvedUpdateCostCodeId !== undefined) updates.cost_code_id = resolvedUpdateCostCodeId
  if (parsed.budget_line_id !== undefined) updates.budget_line_id = parsed.budget_line_id
  if (parsed.trade !== undefined) updates.trade = parsed.trade
  if (parsed.scope !== undefined) updates.scope = parsed.scope
  if (parsed.instructions !== undefined) updates.instructions = parsed.instructions
  if (parsed.due_at !== undefined) updates.due_at = parsed.due_at
  if (parsed.due_tz !== undefined) updates.due_tz = parsed.due_tz
  if (parsed.mode !== undefined) updates.mode = parsed.mode
  if (parsed.bond_required !== undefined) updates.bond_required = parsed.bond_required
  if (parsed.status !== undefined) {
    assertBidPackageTransition(existing.status as BidPackageStatus, parsed.status)
    updates.status = parsed.status
  }

  const { data, error } = await supabase
    .from("bid_packages")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update bid package: ${error?.message}`)
  }

  if (parsed.status) {
    await recordBidPackageStatusChange({
      supabase,
      orgId: resolvedOrgId,
      userId,
      bidPackageId: data.id as string,
      projectId: existing.project_id,
      from: existing.status as BidPackageStatus,
      to: parsed.status,
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_package",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  // Check if due date was updated and notify active bidders
  if (isDueDateUpdated) {
    try {
      const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, data)

      // Fetch org details for email
      const { data: org } = await supabase
        .from("orgs")
        .select("id, name, logo_url, slug")
        .eq("id", resolvedOrgId)
        .maybeSingle()

      // Fetch active subcontractor invites to notify them
      const { data: invites } = await supabase
        .from("bid_invites")
        .select(`
          id, org_id, bid_package_id, company_id, contact_id, invite_email, status,
          company:companies!bid_invites_org_company_fk(id, name, email),
          contact:contacts!bid_invites_org_contact_fk(id, full_name, email)
        `)
        .eq("org_id", resolvedOrgId)
        .eq("bid_package_id", bidPackageId)
        .in("status", ["sent", "viewed", "submitted"])

      if (invites && invites.length > 0) {
        for (const inviteRow of invites) {
          const invite = mapBidInvite(inviteRow)
          const emailTo = invite.invite_email || invite.contact?.email || invite.company?.email
          if (!emailTo) continue

          try {
            const { url: bidLink } = await createBidInviteLink({
              supabase,
              orgId: resolvedOrgId,
              userId,
              inviteId: invite.id,
              markSent: false,
              revokeExisting: false,
            })

            await enqueueBidEmail(resolvedOrgId, {
              kind: "date_update",
              to: emailTo,
              companyName: invite.company?.name,
              contactName: invite.contact?.full_name,
              projectName: jobName,
              bidPackageTitle: data.title,
              oldDueDate: existing.due_at,
              newDueDate: data.due_at as string,
              orgName: org?.name,
              orgLogoUrl: org?.logo_url,
              bidLink,
              orgSlug: org?.slug,
              bidPackageId,
              inviteId: invite.id,
            })
          } catch (emailError) {
            console.error(`Failed to queue bid due date update email to ${emailTo}:`, emailError)
          }
        }
      }
    } catch (emailBlockError) {
      console.error("Failed to queue bid due date update email notifications:", emailBlockError)
    }
  }

  return mapBidPackage(data)
}

export async function listBidInvites(bidPackageId: string, orgId?: string): Promise<BidInvite[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_invites")
    .select(
      `
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies!bid_invites_org_company_fk(id, name, phone, email),
      contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid invites: ${error.message}`)
  }

  const invites = (data ?? []).map(mapBidInvite)
  if (invites.length === 0) return invites
  // Awarding to a vendor whose coverage lapsed is a mistake worth catching
  // before the contract, not at their first payable.
  const companyIds = invites.map((invite) => invite.company_id)
  const [prequalificationWarnings, complianceWarnings] = await Promise.all([
    getBidInvitePrequalificationWarnings(companyIds, resolvedOrgId),
    getBidInviteComplianceWarnings(companyIds, resolvedOrgId),
  ])

  const inviteIds = invites.map((invite) => invite.id)
  const { data: tokenRows, error: tokenError } = await supabase
    .from("bid_access_tokens")
    .select("id, bid_invite_id, paused_at, revoked_at, require_account")
    .eq("org_id", resolvedOrgId)
    .in("bid_invite_id", inviteIds)

  if (tokenError) {
    throw new Error(`Failed to load bid invite access state: ${tokenError.message}`)
  }

  const countsByInvite = new Map<
    string,
    { total: number; active: number; paused: number; revoked: number; requireAccountEnforced: boolean; tokenIds: string[] }
  >()

  for (const inviteId of inviteIds) {
    countsByInvite.set(inviteId, {
      total: 0,
      active: 0,
      paused: 0,
      revoked: 0,
      requireAccountEnforced: false,
      tokenIds: [],
    })
  }

  for (const row of tokenRows ?? []) {
    const bucket = countsByInvite.get(row.bid_invite_id)
    if (!bucket) continue
    bucket.total += 1
    bucket.tokenIds.push(row.id as string)
    if (row.require_account) bucket.requireAccountEnforced = true
    if (row.revoked_at) {
      bucket.revoked += 1
    } else if (row.paused_at) {
      bucket.paused += 1
    } else {
      bucket.active += 1
    }
  }

  const allTokenIds = Array.from(new Set((tokenRows ?? []).map((row: any) => row.id as string)))
  const accountCountsByToken = new Map<string, { total: number; active: number; paused: number; revoked: number }>()

  if (allTokenIds.length > 0) {
    const { data: grantRows, error: grantError } = await supabase
      .from("external_identity_grants")
      .select("bid_access_token_id, status")
      .eq("org_id", resolvedOrgId)
      .in("bid_access_token_id", allTokenIds)

    if (grantError) {
      throw new Error(`Failed to load linked bid invite accounts: ${grantError.message}`)
    }

    for (const tokenId of allTokenIds) {
      accountCountsByToken.set(tokenId, { total: 0, active: 0, paused: 0, revoked: 0 })
    }
    for (const grant of grantRows ?? []) {
      const tokenId = (grant as any).bid_access_token_id as string | null
      if (!tokenId) continue
      const bucket = accountCountsByToken.get(tokenId)
      if (!bucket) continue
      bucket.total += 1
      if ((grant as any).status === "active") bucket.active += 1
      if ((grant as any).status === "paused") bucket.paused += 1
      if ((grant as any).status === "revoked") bucket.revoked += 1
    }
  }

  return invites.map((invite) => {
    const counts = countsByInvite.get(invite.id)
    const tokenIds = counts?.tokenIds ?? []
    const accountAgg = tokenIds.reduce(
      (acc, tokenId) => {
        const count = accountCountsByToken.get(tokenId)
        if (!count) return acc
        acc.total += count.total
        acc.active += count.active
        acc.paused += count.paused
        acc.revoked += count.revoked
        return acc
      },
      { total: 0, active: 0, paused: 0, revoked: 0 },
    )
    return {
      ...invite,
      access_total: counts?.total ?? 0,
      active_access_count: counts?.active ?? 0,
      paused_access_count: counts?.paused ?? 0,
      revoked_access_count: counts?.revoked ?? 0,
      require_account_enforced: counts?.requireAccountEnforced ?? false,
      linked_account_count: accountAgg.total,
      linked_active_account_count: accountAgg.active,
      linked_paused_account_count: accountAgg.paused,
      linked_revoked_account_count: accountAgg.revoked,
      prequalification_warning: prequalificationWarnings.get(invite.company_id),
      compliance_warning: complianceWarnings.get(invite.company_id),
    }
  })
}

async function updateBidInviteAccessState({
  inviteId,
  state,
  orgId,
}: {
  inviteId: string
  state: "pause" | "resume" | "revoke"
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, org_id, bid_package_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  await ensureBidPackageInOrg(invite.bid_package_id, resolvedOrgId, supabase)

  if (state === "pause") {
    const { error } = await supabase
      .from("bid_access_tokens")
      .update({ paused_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("bid_invite_id", inviteId)
      .is("revoked_at", null)
      .is("paused_at", null)
    if (error) throw new Error(`Failed to pause bid access: ${error.message}`)
  } else if (state === "resume") {
    const { error } = await supabase
      .from("bid_access_tokens")
      .update({ paused_at: null })
      .eq("org_id", resolvedOrgId)
      .eq("bid_invite_id", inviteId)
      .is("revoked_at", null)
      .not("paused_at", "is", null)
    if (error) throw new Error(`Failed to resume bid access: ${error.message}`)
  } else {
    const { error } = await supabase
      .from("bid_access_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("bid_invite_id", inviteId)
      .is("revoked_at", null)
    if (error) throw new Error(`Failed to revoke bid access: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: `bid_invite_access_${state}d`,
    entityType: "bid_invite",
    entityId: inviteId,
    payload: { bid_package_id: invite.bid_package_id, state },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_invite_access",
    entityId: inviteId,
    after: { state, bid_package_id: invite.bid_package_id },
  })
}

export async function pauseBidInviteAccess(inviteId: string, orgId?: string) {
  await updateBidInviteAccessState({ inviteId, state: "pause", orgId })
}

export async function resumeBidInviteAccess(inviteId: string, orgId?: string) {
  await updateBidInviteAccessState({ inviteId, state: "resume", orgId })
}

export async function revokeBidInviteAccess(inviteId: string, orgId?: string) {
  await updateBidInviteAccessState({ inviteId, state: "revoke", orgId })
}

export async function setBidInviteRequireAccount({
  inviteId,
  requireAccount,
  orgId,
}: {
  inviteId: string
  requireAccount: boolean
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidInviteAccess(inviteId, resolvedOrgId, supabase)

  const { error } = await supabase
    .from("bid_access_tokens")
    .update({ require_account: requireAccount })
    .eq("org_id", resolvedOrgId)
    .eq("bid_invite_id", inviteId)
    .is("revoked_at", null)

  if (error) {
    throw new Error(`Failed to update bid invite account requirement: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_invite_access",
    entityId: inviteId,
    after: { require_account: requireAccount },
  })
}

export async function createBidInvite({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidInvite> {
  const parsed = createBidInviteInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)
  await ensureCompanyInOrg(parsed.company_id, resolvedOrgId, supabase)
  const prequalificationWarning = (await getBidInvitePrequalificationWarnings([parsed.company_id], resolvedOrgId)).get(parsed.company_id)
  if (parsed.contact_id) {
    await ensureContactInOrg(parsed.contact_id, resolvedOrgId, supabase)
  }

  const { data, error } = await supabase
    .from("bid_invites")
    .insert({
      org_id: resolvedOrgId,
      bid_package_id: parsed.bid_package_id,
      company_id: parsed.company_id,
      contact_id: parsed.contact_id ?? null,
      invite_email: parsed.invite_email ?? null,
      status: parsed.status ?? "draft",
      created_by: userId,
    })
    .select(
      `
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies!bid_invites_org_company_fk(id, name, phone, email),
      contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create bid invite: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_invite_created",
    entityType: "bid_invite",
    entityId: data.id as string,
    payload: { bid_package_id: parsed.bid_package_id, company_id: parsed.company_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_invite",
    entityId: data.id as string,
    after: data,
  })

  return { ...mapBidInvite(data), prequalification_warning: prequalificationWarning }
}

export interface BulkBidInviteResult {
  created: BidInvite[]
  failed: Array<{ identifier: string; error: string }>
  emailsSent: number
  companiesCreated: number
}

export async function bulkCreateBidInvites({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BulkBidInviteResult> {
  const parsed = bulkCreateBidInvitesInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  // Fetch bid package details for email
  const { data: bidPackage, error: bidPackageError } = await supabase
    .from("bid_packages")
    .select("id, project_id, prospect_id, title, trade, due_at, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_package_id)
    .maybeSingle()

  if (bidPackageError || !bidPackage) {
    throw new Error("Bid package not found")
  }

  const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, bidPackage)

  // Fetch org name for email
  const { data: org } = await supabase
    .from("orgs")
    .select("id, name, logo_url, slug")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const created: BidInvite[] = []
  const failed: Array<{ identifier: string; error: string }> = []
  let emailsSent = 0
  let companiesCreated = 0
  const validatedCompanyIds = new Set<string>()
  const validatedContactIds = new Set<string>()

  for (const inviteItem of parsed.invites) {
    const identifier = inviteItem.company_id || inviteItem.invite_email || "unknown"
    try {
      let companyId = inviteItem.company_id

      // If no company_id but we have an email, reuse an existing company before creating a placeholder.
      if (!companyId && inviteItem.invite_email) {
        const normalizedEmail = inviteItem.invite_email.trim().toLowerCase()
        const { data: existingCompany } = await supabase
          .from("companies")
          .select("id")
          .eq("org_id", resolvedOrgId)
          .eq("email", normalizedEmail)
          .maybeSingle()

        if (existingCompany?.id) {
          companyId = existingCompany.id
        }
      }

      if (!companyId && inviteItem.invite_email) {
        const emailDomain = inviteItem.invite_email.split("@")[1] ?? ""
        const companyName = inviteItem.company_name ||
          (emailDomain ? emailDomain.split(".")[0].charAt(0).toUpperCase() + emailDomain.split(".")[0].slice(1) : "Unknown Company")

        const { data: newCompany, error: companyError } = await supabase
          .from("companies")
          .insert({
            org_id: resolvedOrgId,
            name: companyName,
            email: inviteItem.invite_email,
            company_type: "subcontractor",
            metadata: {
              trade: bidPackage.trade ?? null,
            },
          })
          .select("id")
          .single()

        if (companyError || !newCompany) {
          failed.push({
            identifier,
            error: companyError?.message ?? "Failed to create company",
          })
          continue
        }

        const createdCompanyId = newCompany.id as string
        companyId = createdCompanyId

        // Inviting someone to bid makes them a vendor in this org. Without the
        // role row the new company is invisible to the vendor lens, the
        // compliance watch list and its own account tabs; without the audit it
        // never reaches the search index.
        await assignPartyRoleWithClient(supabase, resolvedOrgId, userId, {
          kind: "company",
          partyId: createdCompanyId,
          roleKey: "subcontractor",
          status: "invited",
          source: "system",
        })
        await recordAudit({
          orgId: resolvedOrgId,
          actorId: userId ?? undefined,
          action: "insert",
          entityType: "company",
          entityId: createdCompanyId,
          after: newCompany,
        })
        companiesCreated++
      }

      if (!companyId) {
        failed.push({
          identifier,
          error: "No company ID and no email provided",
        })
        continue
      }

      if (!validatedCompanyIds.has(companyId)) {
        await ensureCompanyInOrg(companyId, resolvedOrgId, supabase)
        validatedCompanyIds.add(companyId)
      }

      if (inviteItem.contact_id && !validatedContactIds.has(inviteItem.contact_id)) {
        await ensureContactInOrg(inviteItem.contact_id, resolvedOrgId, supabase)
        validatedContactIds.add(inviteItem.contact_id)
      }

      // Create the invite
      const { data, error } = await supabase
        .from("bid_invites")
        .insert({
          org_id: resolvedOrgId,
          bid_package_id: parsed.bid_package_id,
          company_id: companyId,
          contact_id: inviteItem.contact_id ?? null,
          invite_email: inviteItem.invite_email ?? null,
          status: "draft",
          created_by: userId,
        })
        .select(
          `
          id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
          declined_at, created_by, created_at, updated_at,
          company:companies!bid_invites_org_company_fk(id, name, phone, email),
          contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
        `
        )
        .single()

      if (error || !data) {
        const message =
          (error as any)?.code === "23505"
            ? "Company already invited to this bid package"
            : error?.message ?? "Failed to create invite"
        failed.push({
          identifier,
          error: message,
        })
        continue
      }

      const invite = mapBidInvite(data)

      // A draft package lines trades up: no link, no email. The bid portal
      // refuses draft packages, so a link minted now would be dead on arrival;
      // sendBidPackage() mints and emails every lined-up trade at once.
      if (bidPackage.status !== "draft") {
        let bidLink: string
        try {
          const link = await createBidInviteLink({
            supabase,
            orgId: resolvedOrgId,
            userId,
            inviteId: invite.id,
            markSent: true,
            revokeExisting: false,
          })
          bidLink = link.url
        } catch (tokenError) {
          await supabase
            .from("bid_invites")
            .delete()
            .eq("org_id", resolvedOrgId)
            .eq("id", invite.id)
          failed.push({
            identifier,
            error: (tokenError as Error)?.message ?? "Failed to create invite access token",
          })
          continue
        }

        invite.status = "sent"
        invite.sent_at = new Date().toISOString()

        // Queue email if enabled and we have an email address
        if (parsed.send_emails) {
          const emailTo =
            inviteItem.invite_email ||
            invite.contact?.email ||
            invite.company?.email

          if (emailTo) {
            try {
              await enqueueBidInviteEmail({
                orgId: resolvedOrgId,
                to: emailTo,
                invite,
                bidPackage: { id: parsed.bid_package_id, title: bidPackage.title, trade: bidPackage.trade, due_at: bidPackage.due_at },
                jobName,
                org,
                bidLink,
              })
              emailsSent++
            } catch (emailError) {
              console.error("Failed to queue bid invite email:", emailError)
              // Don't fail the invite creation if email fails
            }
          }
        }
      }

      await recordEvent({
        orgId: resolvedOrgId,
        eventType: "bid_invite_created",
        entityType: "bid_invite",
        entityId: invite.id,
        payload: { bid_package_id: parsed.bid_package_id, company_id: companyId },
      })

      await recordAudit({
        orgId: resolvedOrgId,
        actorId: userId,
        action: "insert",
        entityType: "bid_invite",
        entityId: invite.id,
        after: data,
      })

      created.push(invite)
    } catch (err) {
      failed.push({
        identifier,
        error: (err as Error)?.message ?? "Unknown error",
      })
    }
  }

  const warningByCompany = await getBidInvitePrequalificationWarnings(created.map((invite) => invite.company_id), resolvedOrgId)
  return {
    created: created.map((invite) => ({ ...invite, prequalification_warning: warningByCompany.get(invite.company_id) })),
    failed,
    emailsSent,
    companiesCreated,
  }
}

export async function generateBidInviteLink(
  inviteId: string,
  orgId?: string,
  options?: { revokeExisting?: boolean },
): Promise<{ url: string; token: string }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  const revokeExisting = options?.revokeExisting ?? true
  const link = await createBidInviteLink({
    supabase,
    orgId: resolvedOrgId,
    userId,
    inviteId,
    markSent: true,
    revokeExisting,
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_invite_access",
    entityId: inviteId,
    after: revokeExisting ? { link_rotated: true } : { link_issued: true },
  })

  return link
}

export async function resendBidInvite({
  inviteId,
  orgId,
}: {
  inviteId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: inviteRow, error: inviteError } = await supabase
    .from("bid_invites")
    .select(`
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies!bid_invites_org_company_fk(id, name, phone, email),
      contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone),
      bid_package:bid_packages!bid_invites_org_package_fk(id, title, trade, due_at, project_id, prospect_id)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !inviteRow) {
    throw new Error("Bid invite not found")
  }

  await ensureBidPackageInOrg(inviteRow.bid_package_id, resolvedOrgId, supabase)

  const invite = mapBidInvite(inviteRow)
  const bidPackage = Array.isArray((inviteRow as any).bid_package)
    ? (inviteRow as any).bid_package[0]
    : (inviteRow as any).bid_package
  const emailTo = getBidEmailRecipient(invite)
  if (!emailTo) {
    throw new Error("This invite does not have an email recipient")
  }

  const { data: org } = await supabase
    .from("orgs")
    .select("id, name, logo_url, slug")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const bidLink = await createBidInviteLink({
    supabase,
    orgId: resolvedOrgId,
    userId,
    inviteId,
    markSent: true,
  })

  const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, bidPackage ?? {})

  await enqueueBidInviteEmail({
    orgId: resolvedOrgId,
    to: emailTo,
    invite,
    bidPackage: {
      id: bidPackage?.id ?? invite.bid_package_id,
      title: bidPackage?.title ?? "Bid package",
      trade: bidPackage?.trade ?? null,
      due_at: bidPackage?.due_at ?? null,
    },
    jobName,
    org,
    bidLink: bidLink.url,
    resentBy: userId,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_invite_resent",
    entityType: "bid_invite",
    entityId: inviteId,
    payload: { bid_package_id: invite.bid_package_id, company_id: invite.company_id },
  })

  return { success: true }
}

const BID_INVITE_WITH_PARTIES_COLUMNS = `
  id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
  declined_at, created_by, created_at, updated_at,
  company:companies!bid_invites_org_company_fk(id, name, phone, email),
  contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
`

export interface SendBidPackageResult {
  sent: number
  failed: Array<{ inviteId: string; companyName: string | null; error: string }>
}

/**
 * Sends a draft package: validates it is ready to go out, opens it, then mints
 * a link for and emails every lined-up (draft) trade. Per-trade failures are
 * collected, never thrown, so one bad invite does not strand the rest.
 */
export async function sendBidPackage({
  bidPackageId,
  orgId,
}: {
  bidPackageId: string
  orgId?: string
}): Promise<SendBidPackageResult> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const [packageResult, scopeResult, invitesResult] = await Promise.all([
    supabase
      .from("bid_packages")
      .select(BID_PACKAGE_COLUMNS)
      .eq("org_id", resolvedOrgId)
      .eq("id", bidPackageId)
      .maybeSingle(),
    supabase
      .from("bid_scope_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId),
    supabase
      .from("bid_invites")
      .select(BID_INVITE_WITH_PARTIES_COLUMNS)
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId)
      .eq("status", "draft"),
  ])

  const existing = packageResult.data
  if (packageResult.error || !existing) {
    throw new Error("Bid package not found")
  }
  if (scopeResult.error) {
    throw new Error(`Failed to check scope lines: ${scopeResult.error.message}`)
  }
  if (invitesResult.error) {
    throw new Error(`Failed to load trades: ${invitesResult.error.message}`)
  }

  if (existing.status !== "draft") {
    throw new Error("Only a draft bid package can be sent. This one has already gone out.")
  }
  if (!existing.due_at || new Date(existing.due_at).getTime() <= Date.now()) {
    throw new Error("Set a due date in the future before sending")
  }
  if (existing.mode === "tender" && (scopeResult.count ?? 0) === 0) {
    throw new Error("Add at least one scope line before sending a tender")
  }
  const invites = (invitesResult.data ?? []).map(mapBidInvite)
  if (invites.length === 0) {
    throw new Error("Add at least one trade before sending")
  }

  const from = existing.status as BidPackageStatus
  const to: BidPackageStatus = "open"
  assertBidPackageTransition(from, to)

  // Guarded on draft so two concurrent sends cannot both open and email.
  const { data: opened, error: openError } = await supabase
    .from("bid_packages")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", bidPackageId)
    .eq("status", "draft")
    .select(BID_PACKAGE_COLUMNS)
    .maybeSingle()

  if (openError) {
    throw new Error(`Failed to send bid package: ${openError.message}`)
  }
  if (!opened) {
    throw new Error("Only a draft bid package can be sent. This one has already gone out.")
  }

  await recordBidPackageStatusChange({
    supabase,
    orgId: resolvedOrgId,
    userId,
    bidPackageId,
    projectId: existing.project_id,
    from,
    to,
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_package",
    entityId: bidPackageId,
    before: existing,
    after: opened,
  })

  const [jobName, orgResult] = await Promise.all([
    resolveBidPackageJobName(supabase, resolvedOrgId, existing),
    supabase.from("orgs").select("id, name, logo_url, slug").eq("id", resolvedOrgId).maybeSingle(),
  ])
  const org = orgResult.data

  let sent = 0
  const failed: SendBidPackageResult["failed"] = []

  for (const invite of invites) {
    const companyName = invite.company?.name ?? null
    try {
      const link = await createBidInviteLink({
        supabase,
        orgId: resolvedOrgId,
        userId,
        inviteId: invite.id,
        markSent: true,
        revokeExisting: false,
      })

      await recordEvent({
        orgId: resolvedOrgId,
        actorId: userId,
        eventType: "bid_invite_sent",
        entityType: "bid_invite",
        entityId: invite.id,
        payload: { bid_package_id: bidPackageId, company_id: invite.company_id },
      })

      const emailTo = getBidEmailRecipient(invite)
      if (!emailTo) {
        failed.push({ inviteId: invite.id, companyName, error: "No email on file — copy their link instead" })
        continue
      }

      await enqueueBidInviteEmail({
        orgId: resolvedOrgId,
        to: emailTo,
        invite,
        bidPackage: { id: bidPackageId, title: existing.title, trade: existing.trade, due_at: existing.due_at },
        jobName,
        org,
        bidLink: link.url,
      })
      sent++
    } catch (error) {
      failed.push({
        inviteId: invite.id,
        companyName,
        error: error instanceof Error ? error.message : "Failed to send to this trade",
      })
    }
  }

  return { sent, failed }
}

/** Takes a lined-up trade off a package. Once a trade has been sent the
 * package, the record stays and access is revoked instead. */
export async function removeBidInvite({ inviteId, orgId }: { inviteId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, created_by, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  await ensureBidPackageInOrg(invite.bid_package_id, resolvedOrgId, supabase)

  if (invite.status !== "draft") {
    throw new Error("Only trades that haven't been sent the package can be removed. Revoke their access instead.")
  }

  const { error } = await supabase
    .from("bid_invites")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", inviteId)
    .eq("status", "draft")

  if (error) {
    throw new Error(`Failed to remove trade: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_invite_removed",
    entityType: "bid_invite",
    entityId: inviteId,
    payload: { bid_package_id: invite.bid_package_id, company_id: invite.company_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "bid_invite",
    entityId: inviteId,
    before: invite,
  })
}

export async function listBidAddenda(bidPackageId: string, orgId?: string): Promise<BidAddendum[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_addenda")
    .select("id, org_id, bid_package_id, number, title, message, issued_at, created_by")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .order("number", { ascending: true })

  if (error) {
    throw new Error(`Failed to list addenda: ${error.message}`)
  }

  return (data ?? []).map(mapBidAddendum)
}

export async function createBidAddendum({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidAddendum & { notifications: BidNotificationOutcome }> {
  const parsed = createBidAddendumInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  // The insert fires bid_addendum_reconfirmation, which snapshots the scope into
  // bid_scope_revisions (service-role write) and bumps the package revision. It runs
  // as the inserting role, so the insert goes through the service client once the
  // caller is authorized above.
  const service = createServiceSupabaseClient()
  const { data: existing } = await service
    .from("bid_addenda")
    .select("number")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", parsed.bid_package_id)
    .order("number", { ascending: false })
    .limit(1)

  const nextNumber = (existing?.[0]?.number ?? 0) + 1

  const { data, error } = await service
    .from("bid_addenda")
    .insert({
      org_id: resolvedOrgId,
      bid_package_id: parsed.bid_package_id,
      number: nextNumber,
      title: parsed.title ?? null,
      message: parsed.message ?? null,
      created_by: userId,
    })
    .select("id, org_id, bid_package_id, number, title, message, issued_at, created_by")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create addendum: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "bid_addendum_created",
    entityType: "bid_addendum",
    entityId: data.id as string,
    payload: { bid_package_id: parsed.bid_package_id, number: nextNumber },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_addendum",
    entityId: data.id as string,
    after: data,
  })

  const notifications = await retryBidAddendumNotifications({ addendumId: data.id, orgId: resolvedOrgId }).catch((): BidNotificationOutcome => ({
    addendumId: data.id, queued: [], alreadyQueued: [], failed: [{ recipient: "Bidders", error: "The notice was saved, but notifications could not be queued. Retry delivery." }],
  }));
  return { ...mapBidAddendum(data), notifications };
}

export type BidNotificationOutcome = {
  addendumId: string;
  queued: string[];
  alreadyQueued: string[];
  failed: Array<{ inviteId?: string; recipient: string; error: string }>;
};

/** Retry the same notice; never manufacture a second addendum or invalidate existing links. */
export async function retryBidAddendumNotifications({ addendumId, orgId }: { addendumId: string; orgId?: string }): Promise<BidNotificationOutcome> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId);
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId });
  const { data: notice, error } = await supabase.from("bid_addenda").select("*").eq("org_id", resolvedOrgId).eq("id", addendumId).single();
  if (error || !notice) throw new Error("Bid notice not found.");
  const pkg = await getBidPackage(notice.bid_package_id, resolvedOrgId);
  const result: BidNotificationOutcome = { addendumId, queued: [], alreadyQueued: [], failed: [] };
  try {
    const inviteRows = await supabase.from("bid_invites").select("id,org_id,bid_package_id,company_id,contact_id,invite_email,status,company:companies!bid_invites_org_company_fk(id,name,email),contact:contacts!bid_invites_org_contact_fk(id,full_name,email)").eq("org_id", resolvedOrgId).eq("bid_package_id", pkg.id).in("status", ["sent", "viewed", "submitted"]);
    if (inviteRows.error) throw new Error("Unable to load bidder recipients.");
    const invites = (inviteRows.data ?? []).map(mapBidInvite);
    const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, pkg);
    const { data: org, error: orgError } = await supabase.from("orgs").select("id,name,logo_url,slug").eq("id", resolvedOrgId).single();
    if (orgError) throw new Error("Unable to load sender details.");
    const service = createServiceSupabaseClient();
    for (const invite of invites) {
      const recipient = getBidEmailRecipient(invite);
      if (!recipient) {
        result.failed.push({ inviteId: invite.id, recipient: invite.company?.name ?? "Bidder", error: "No email address is available." });
        continue;
      }
      try {
        const existing = await service.from("outbox").select("id").eq("org_id", resolvedOrgId).eq("job_type", "send_bid_email").contains("payload", { kind: "addendum", addendumId, inviteId: invite.id }).in("status", ["pending", "processing", "completed"]).limit(1);
        if (existing.error) throw new Error("Unable to check notification delivery.");
        if (existing.data?.length) { result.alreadyQueued.push(recipient); continue; }
        const { url: bidLink } = await createBidInviteLink({ supabase, orgId: resolvedOrgId, userId, inviteId: invite.id, markSent: false, revokeExisting: false });
        const queued = await enqueueBidEmail(resolvedOrgId, {
          kind: "addendum", to: recipient, companyName: invite.company?.name, contactName: invite.contact?.full_name,
          projectName: jobName, bidPackageTitle: pkg.title, addendumNumber: notice.number,
          addendumTitle: notice.title, addendumMessage: notice.message, orgName: org?.name, orgLogoUrl: org?.logo_url,
          bidLink, orgSlug: org?.slug, bidPackageId: pkg.id, inviteId: invite.id, addendumId,
        }, ["kind", "addendumId", "inviteId"]);
        if (!queued.enqueued && queued.reason !== "duplicate") throw new Error("Notification could not be queued. Retry delivery.");
        if (queued.enqueued) result.queued.push(recipient);
        else result.alreadyQueued.push(recipient);
      } catch (cause) {
        result.failed.push({ inviteId: invite.id, recipient, error: cause instanceof Error ? cause.message : "Unable to queue notification." });
      }
    }
  } catch (cause) {
    result.failed.push({ recipient: "Bidders", error: cause instanceof Error ? cause.message : "Unable to load recipients." });
  }
  return result;
}

export async function listBidSubmissions(bidPackageId: string, orgId?: string): Promise<BidSubmission[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const accessPackage = await ensureBidPackageInOrg(bidPackageId,resolvedOrgId,supabase)
  await assertBidProjectVisibility(accessPackage.project_id,resolvedOrgId,userId,supabase,accessPackage)
  const { data: inviteRows, error: inviteError } = await supabase
    .from("bid_invites")
    .select(
      `
      id, org_id, bid_package_id, company_id, contact_id, invite_email, status, sent_at, last_viewed_at, submitted_at,
      declined_at, created_by, created_at, updated_at,
      company:companies!bid_invites_org_company_fk(id, name, phone, email),
      contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)

  if (inviteError) {
    throw new Error(`Failed to list bid invites for submissions: ${inviteError.message}`)
  }

  const inviteIdList = (inviteRows ?? []).map((row) => row.id as string)
  if (inviteIdList.length === 0) {
    return []
  }

  const inviteById = new Map<string, BidInvite>((inviteRows ?? []).map((row) => [row.id as string, mapBidInvite(row)]))

  const { data, error } = await supabase
    .from("bid_submissions")
    .select(
      `
      id, org_id, bid_invite_id, status, version, is_current, total_cents, currency, submitted_at, created_at,
      valid_until, lead_time_days, duration_days, start_available_on,
      exclusions, clarifications, notes, submitted_by_name, submitted_by_email,
      source, entered_by, entered_at, leveled_adjustment_cents, leveling_notes, line_items, benchmark,
      items:bid_submission_items!bid_submission_items_org_submission_fk(
        id, bid_submission_id, bid_scope_item_id, description, response,
        amount_cents, unit_rate_cents, quantity, notes, gc_plug_cents, gc_note
      )
    `,
    )
    .eq("org_id", resolvedOrgId)
    .in("bid_invite_id", inviteIdList)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid submissions: ${error.message}`)
  }

  const { data: award, error: awardError } = await supabase
    .from("bid_awards")
    .select("awarded_submission_id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .is("rescinded_at", null)
    .order("awarded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (awardError) {
    throw new Error(`Failed to resolve awarded submission: ${awardError.message}`)
  }

  const companyIds = Array.from(inviteById.values()).map(invite => invite.company_id)
  const [prequal, compliance] = await Promise.all([getBidInvitePrequalificationWarnings(companyIds, resolvedOrgId), getBidInviteComplianceWarnings(companyIds, resolvedOrgId)])
  for (const invite of inviteById.values()) {
    invite.prequalification_warning = prequal.get(invite.company_id)
    invite.compliance_warning = compliance.get(invite.company_id)
  }
  const revisionResult = await supabase.from("bid_submissions").select("id,scope_revision").eq("org_id",resolvedOrgId).in("id",(data ?? []).map(row=>row.id))
  if(revisionResult.error && !pricingSchemaMissing(revisionResult.error)) throw new Error(revisionResult.error.message)
  const { data: pricingDecision, error: decisionError } = await createServiceSupabaseClient().from("bid_pricing_decisions").select("*").eq("org_id", resolvedOrgId).eq("bid_package_id", bidPackageId).is("superseded_at", null).maybeSingle()
  if (decisionError && !pricingSchemaMissing(decisionError)) throw new Error(`Failed to load pricing decision: ${decisionError.message}`)
  const awardedSubmissionId = (award as any)?.awarded_submission_id as string | undefined
  const rows = (data ?? []).map((row) => ({
    ...mapBidSubmission({ ...row, scope_revision: revisionResult.data?.find(entry=>entry.id===row.id)?.scope_revision ?? 1, is_awarded: awardedSubmissionId === row.id }),
    invite: inviteById.get(row.bid_invite_id as string),
    pricing_decision: pricingDecision?.bid_submission_id === row.id ? pricingDecision as BidPricingDecision : null,
  }))

  return rows
}

async function recordBidBenchmarkBestEffort(submissionId: string) {
  try {
    const serviceSupabase = createServiceSupabaseClient()
    const { data } = await serviceSupabase.rpc("record_bid_submission_benchmark", {
      p_bid_submission_id: submissionId,
    })
    const row = Array.isArray(data) ? data[0] : data
    if (row) {
      // Persist the signal snapshot so list reads carry it without recomputing
      await serviceSupabase
        .from("bid_submissions")
        .update({ benchmark: row })
        .eq("id", submissionId)
    }
  } catch (benchmarkError) {
    console.warn("Failed to record bid benchmark signal", {
      submissionId,
      error: (benchmarkError as Error)?.message,
    })
  }
}

export async function createManualBidSubmission({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidSubmission> {
  const parsed = manualBidSubmissionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)
  if (parsed.company_id) {
    await ensureCompanyInOrg(parsed.company_id, resolvedOrgId, supabase)
  }
  if (parsed.contact_id) {
    await ensureContactInOrg(parsed.contact_id, resolvedOrgId, supabase)
  }

  let inviteId = parsed.bid_invite_id ?? null
  let inviteRow: any | null = null

  if (inviteId) {
    const { data, error } = await supabase
      .from("bid_invites")
      .select("id, org_id, bid_package_id, company_id, contact_id, invite_email, status")
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", parsed.bid_package_id)
      .eq("id", inviteId)
      .maybeSingle()
    if (error || !data) {
      throw new Error("Bid invite not found for this package")
    }
    inviteRow = data
  } else {
    const { data: existingInvite } = await supabase
      .from("bid_invites")
      .select("id, org_id, bid_package_id, company_id, contact_id, invite_email, status")
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", parsed.bid_package_id)
      .eq("company_id", parsed.company_id)
      .maybeSingle()

    if (existingInvite?.id) {
      inviteRow = existingInvite
      inviteId = existingInvite.id
    } else {
      const { data: createdInvite, error: createInviteError } = await supabase
        .from("bid_invites")
        .insert({
          org_id: resolvedOrgId,
          bid_package_id: parsed.bid_package_id,
          company_id: parsed.company_id,
          contact_id: parsed.contact_id ?? null,
          invite_email: parsed.invite_email ?? null,
          status: "submitted",
          submitted_at: new Date().toISOString(),
          created_by: userId,
        })
        .select("id, org_id, bid_package_id, company_id, contact_id, invite_email, status")
        .single()

      if (createInviteError || !createdInvite) {
        throw new Error(`Failed to create invite for manual bid: ${createInviteError?.message}`)
      }

      inviteRow = createdInvite
      inviteId = createdInvite.id
    }
  }

  if (!inviteId || !inviteRow) {
    throw new Error("Unable to resolve bid invite")
  }

  const serviceSupabase = createServiceSupabaseClient()
  const { data: rpcResult, error: rpcError } = await serviceSupabase.rpc("create_bid_submission_version", {
    p_org_id: resolvedOrgId,
    p_bid_invite_id: inviteId,
    p_payload: {
      total_cents: parsed.total_cents,
      currency: parsed.currency ?? "usd",
      valid_until: parsed.valid_until ?? null,
      lead_time_days: parsed.lead_time_days ?? null,
      duration_days: parsed.duration_days ?? null,
      start_available_on: parsed.start_available_on ?? null,
      exclusions: parsed.exclusions ?? null,
      clarifications: parsed.clarifications ?? null,
      notes: parsed.notes ?? null,
      submitted_by_name: parsed.submitted_by_name ?? null,
      submitted_by_email: parsed.submitted_by_email ?? parsed.invite_email ?? null,
      line_items: parsed.line_items ?? [],
    },
    p_items: (parsed.items ?? []).map((item) => ({
      bid_scope_item_id: item.bid_scope_item_id ?? null,
      description: item.description,
      response: item.response,
      amount_cents: item.amount_cents ?? null,
      unit_rate_cents: item.unit_rate_cents ?? null,
      quantity: item.quantity ?? null,
      notes: item.notes ?? null,
    })),
    p_source: "manual",
    p_entered_by: userId,
  })

  if (rpcError || !rpcResult) {
    throw new Error(`Failed to create manual bid: ${rpcError?.message}`)
  }

  const createdId = (rpcResult as any).submission_id as string
  if (parsed.leveled_adjustment_cents || parsed.leveling_notes) {
    await supabase
      .from("bid_submissions")
      .update({
        leveled_adjustment_cents: parsed.leveled_adjustment_cents ?? 0,
        leveling_notes: parsed.leveling_notes ?? null,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", createdId)
  }

  const created = { id: createdId }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_submission_manual_entry",
    entityType: "bid_submission",
    entityId: created.id as string,
    payload: {
      bid_package_id: parsed.bid_package_id,
      bid_invite_id: inviteId,
      company_id: inviteRow.company_id,
      total_cents: parsed.total_cents,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "bid_submission",
    entityId: created.id,
    after: {
      bid_package_id: parsed.bid_package_id,
      bid_invite_id: inviteId,
      total_cents: parsed.total_cents,
      source: "manual",
    },
  })

  await recordBidBenchmarkBestEffort(created.id)

  const refreshed = await listBidSubmissions(parsed.bid_package_id, resolvedOrgId)
  const found = refreshed.find((submission) => submission.id === created.id)
  if (!found) {
    throw new Error("Manual bid was created but could not be reloaded")
  }
  return found
}

export async function updateBidSubmissionLeveling({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidSubmission> {
  const parsed = updateBidSubmissionLevelingInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  await ensureBidSubmissionAccess(parsed.bid_submission_id, resolvedOrgId, supabase)

  const updates: Record<string, any> = {
    leveled_adjustment_cents: parsed.leveled_adjustment_cents,
    leveling_notes: parsed.leveling_notes ?? null,
    updated_at: new Date().toISOString(),
  }
  if (parsed.line_items !== undefined) {
    updates.line_items = parsed.line_items
  }

  const { data, error } = await supabase
    .from("bid_submissions")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_submission_id)
    .select(
      `
      id, org_id, bid_invite_id, status, version, is_current, total_cents, currency, submitted_at, created_at,
      valid_until, lead_time_days, duration_days, start_available_on,
      exclusions, clarifications, notes, submitted_by_name, submitted_by_email,
      source, entered_by, entered_at, leveled_adjustment_cents, leveling_notes, line_items
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update bid leveling: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_submission_leveled",
    entityType: "bid_submission",
    entityId: data.id as string,
    payload: {
      bid_invite_id: data.bid_invite_id,
      leveled_adjustment_cents: parsed.leveled_adjustment_cents,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_submission",
    entityId: data.id as string,
    after: {
      leveled_adjustment_cents: parsed.leveled_adjustment_cents,
      leveling_notes: parsed.leveling_notes ?? null,
    },
  })

  return mapBidSubmission(data)
}

/** Per-cell leveling: a GC plug + note on one scope line of one submission. */
export async function updateBidSubmissionItemLeveling({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidSubmissionItem> {
  const parsed = updateBidSubmissionItemLevelingInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: item, error: itemError } = await supabase.from("bid_submission_items").select("id,bid_submission_id")
    .eq("org_id", resolvedOrgId).eq("id", parsed.bid_submission_item_id).maybeSingle()
  if (itemError || !item) throw new Error("Bid submission item not found")
  await ensureBidSubmissionAccess(item.bid_submission_id, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_submission_items")
    .update({
      gc_plug_cents: parsed.gc_plug_cents ?? null,
      gc_note: parsed.gc_note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_submission_item_id)
    .select(
      "id, bid_submission_id, bid_scope_item_id, description, response, amount_cents, unit_rate_cents, quantity, notes, gc_plug_cents, gc_note",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update leveling cell: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_submission_leveled",
    entityType: "bid_submission",
    entityId: data.bid_submission_id as string,
    payload: {
      bid_submission_item_id: data.id,
      gc_plug_cents: parsed.gc_plug_cents ?? null,
    },
  })

  return mapBidSubmissionItem(data)
}

/** What rescinding a package's active price-book award would void, restore and leave priced on open orders. */
export async function previewRescindImpact({ bidPackageId, orgId }: { bidPackageId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)
  const { data: award, error: awardError } = await supabase.from("bid_awards").select("id")
    .eq("org_id", resolvedOrgId).eq("bid_package_id", bidPackageId).is("rescinded_at", null).maybeSingle()
  if (awardError) throw new Error(`Failed to load the award: ${awardError.message}`)
  if (!award) return { agreementCount: 0, restorableCount: 0, affectedPoCount: 0 }
  const service = createServiceSupabaseClient()
  const { data: minted, error: mintedError } = await service.from("vendor_price_agreements").select("id, metadata")
    .eq("org_id", resolvedOrgId).eq("source_bid_award_id", award.id).in("status", ["draft", "active"])
  if (mintedError) throw new Error(`Failed to load the agreements this award minted: ${mintedError.message}`)
  const ids = (minted ?? []).map((row) => row.id as string)
  const restorable = (minted ?? []).reduce((sum, row) => sum + (Array.isArray(row.metadata?.supersedes) ? row.metadata.supersedes.length : 0), 0)
  if (ids.length === 0) return { agreementCount: 0, restorableCount: restorable, affectedPoCount: 0 }
  const { data: affected, error: countError } = await service.rpc("price_agreement_order_count", { p_org_id: resolvedOrgId, p_agreement_ids: ids })
  if (countError || typeof affected !== "number") throw new Error(`Failed to count the orders priced from this award: ${countError?.message}`)
  return { agreementCount: ids.length, restorableCount: restorable, affectedPoCount: affected }
}

export interface BidAwardRescindResult {
  bidPackageId: string
  commitmentId: string | null
  commitmentCanceled: boolean
  voidedAgreementCount: number
  restoredAgreementCount: number
  skippedAgreementCount: number
  affectedPoCount: number
}

/** Rescind an award: cancels the draft/approved subcontract (refused once
 * bills reference it), reopens the package to closed, and keeps the award row
 * as a rescinded historical record so re-award stays possible. */
export async function rescindBidAward({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidAwardRescindResult> {
  const parsed = rescindBidAwardInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  const { data: award, error: awardError } = await supabase
    .from("bid_awards")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", parsed.bid_package_id)
    .is("rescinded_at", null)
    .order("awarded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (awardError || !award) {
    throw new Error("No active award found for this bid package")
  }

  const serviceSupabase = createServiceSupabaseClient()
  const { data, error } = await serviceSupabase.rpc("rescind_bid_award", {
    p_org_id: resolvedOrgId,
    p_bid_award_id: award.id,
    p_actor_id: userId,
    p_reason: parsed.reason,
  })

  if (error) {
    throw new Error(`Failed to rescind award: ${error.message}`)
  }

  const row = Array.isArray(data) ? data[0] : data

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_award_rescinded",
    entityType: "bid_package",
    entityId: parsed.bid_package_id,
    payload: {
      bid_package_id: parsed.bid_package_id,
      bid_award_id: award.id,
      reason: parsed.reason,
      commitment_id: row?.commitment_id ?? null,
      voided_agreement_ids: row?.voided_agreement_ids ?? [],
      restored_agreement_ids: row?.restored_agreement_ids ?? [],
      skipped_agreement_ids: row?.skipped_agreement_ids ?? [],
      affected_po_count: row?.affected_po_count ?? 0,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_award",
    entityId: award.id,
    after: { rescinded: true, reason: parsed.reason, affected_po_count: row?.affected_po_count ?? 0 },
  })

  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)
  return {
    bidPackageId: parsed.bid_package_id,
    commitmentId: (row?.commitment_id as string | null) ?? null,
    commitmentCanceled: !!row?.commitment_canceled,
    voidedAgreementCount: count(row?.voided_agreement_ids),
    restoredAgreementCount: count(row?.restored_agreement_ids),
    skippedAgreementCount: count(row?.skipped_agreement_ids),
    affectedPoCount: typeof row?.affected_po_count === "number" ? row.affected_po_count : 0,
  }
}

export async function listBidPackageRfis(bidPackageId: string, orgId?: string): Promise<Rfi[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  const bidPackage = await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  if (!bidPackage.project_id) {
    return []
  }

  const { data, error } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, bid_package_id, rfi_number, subject, question, status, priority, submitted_by, submitted_by_company_id, assigned_to, assigned_company_id, submitted_at, due_date, answered_at, closed_at, cost_impact_cents, schedule_impact_days, drawing_reference, spec_reference, location, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", bidPackage.project_id)
    .eq("bid_package_id", bidPackageId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid RFIs: ${error.message}`)
  }

  return (data ?? []) as Rfi[]
}

export async function listBidPackageRfiResponses({
  rfiId,
  orgId,
}: {
  rfiId: string
  orgId?: string
}): Promise<RfiResponse[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  const { data: rfi, error } = await supabase
    .from("rfis")
    .select("id,bid_package_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", rfiId)
    .maybeSingle()

  if (error || !rfi?.bid_package_id) {
    throw new Error("RFI not found")
  }

  await ensureBidPackageInOrg(rfi.bid_package_id, resolvedOrgId, supabase)

  return listRfiResponses({ orgId: resolvedOrgId, rfiId })
}

export async function answerBidPackageRfi({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}) {
  const parsed = answerBidPackageRfiInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("rfi.respond", { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  const { data: rfi, error: rfiError } = await supabase
    .from("rfis")
    .select("id, rfi_number, subject, question, project_id, bid_package_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.rfi_id)
    .eq("bid_package_id", parsed.bid_package_id)
    .maybeSingle()

  if (rfiError || !rfi) {
    throw new Error("RFI not found for this bid package")
  }

  const now = new Date().toISOString()
  const { data: response, error } = await supabase
    .from("rfi_responses")
    .insert({
      org_id: resolvedOrgId,
      rfi_id: parsed.rfi_id,
      response_type: "answer",
      body: parsed.body,
      responder_user_id: userId,
      responder_contact_id: null,
      portal_token_id: null,
      created_via_portal: false,
    })
    .select("id")
    .single()

  if (error || !response) {
    throw new Error(`Failed to answer RFI: ${error?.message}`)
  }

  await supabase
    .from("rfis")
    .update({ status: "answered", answered_at: now, last_response_at: now })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.rfi_id)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "bid_rfi_answered",
    entityType: "rfi",
    entityId: parsed.rfi_id,
    payload: {
      bid_package_id: parsed.bid_package_id,
      rfi_number: rfi.rfi_number,
      response_id: response.id,
      broadcast_as_addendum: parsed.broadcast_as_addendum,
    },
  })

  let addendum: BidAddendum | null = null
  if (parsed.broadcast_as_addendum) {
    addendum = await createBidAddendum({
      orgId: resolvedOrgId,
      input: {
        bid_package_id: parsed.bid_package_id,
        title: `RFI #${rfi.rfi_number} answered: ${rfi.subject}`,
        message: `Question:\n${rfi.question}\n\nAnswer:\n${parsed.body}`,
      },
    })
  }

  return { success: true, responseId: response.id as string, addendum }
}

export async function listBidPackageActivity(bidPackageId: string, orgId?: string): Promise<BidActivityItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("events")
    .select("id, event_type, entity_type, entity_id, payload, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("channel", "activity")
    .or(
      `and(entity_type.eq.bid_package,entity_id.eq.${bidPackageId}),payload->>bid_package_id.eq.${bidPackageId}`,
    )
    .order("created_at", { ascending: false })
    .limit(40)

  if (error) {
    throw new Error(`Failed to list bid activity: ${error.message}`)
  }

  return (data ?? [])
    .map((event: any) => ({
      id: event.id,
      event_type: event.event_type,
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id ?? null,
      payload: event.payload ?? {},
      created_at: event.created_at,
    }))
}

export interface BidPackageAward {
  id: string
  awarded_at: string
  awarded_by_name: string | null
  awarded_submission_id: string
  accepted_alternate_ids: string[]
  notes: string | null
  commitment: {
    id: string
    project_id: string
    title: string
    status: string
    total_cents: number
    contract_number: string | null
    retainage_percent: number | null
    executed_at: string | null
    company_id: string | null
    company_name: string | null
  } | null
  envelope: { id: string; status: string; sent_at: string | null; executed_at: string | null; document_id: string | null } | null
}

/** The package's current (unrescinded) award with the subcontract it cut and
 * that subcontract's live signing envelope. Null when nothing is awarded. */
export async function getBidPackageAward(bidPackageId: string, orgId?: string): Promise<BidPackageAward | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data: award, error: awardError } = await supabase
    .from("bid_awards")
    .select("id, awarded_submission_id, awarded_commitment_id, awarded_by, awarded_at, notes, accepted_alternate_ids")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackageId)
    .is("rescinded_at", null)
    .order("awarded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (awardError) {
    throw new Error(`Failed to load bid award: ${awardError.message}`)
  }
  if (!award) return null

  const commitmentId = (award.awarded_commitment_id as string | null) ?? null
  const awardedBy = (award.awarded_by as string | null) ?? null

  const [commitmentResult, envelopeResult, awardedByResult] = await Promise.all([
    commitmentId
      ? supabase
          .from("commitments")
          .select("id, project_id, title, status, total_cents, contract_number, retainage_percent, executed_at, company_id, company:companies(name)")
          .eq("org_id", resolvedOrgId)
          .eq("id", commitmentId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    commitmentId
      ? supabase
          .from("envelopes")
          .select("id, status, sent_at, executed_at, document_id, created_at")
          .eq("org_id", resolvedOrgId)
          .eq("source_entity_type", "subcontract")
          .eq("source_entity_id", commitmentId)
          .neq("status", "voided")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    awardedBy
      ? supabase.from("app_users").select("full_name").eq("id", awardedBy).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (commitmentResult.error) {
    throw new Error(`Failed to load awarded commitment: ${commitmentResult.error.message}`)
  }
  if (envelopeResult.error) {
    throw new Error(`Failed to load subcontract envelope: ${envelopeResult.error.message}`)
  }

  const commitmentRow = commitmentResult.data
  const companyJoin = commitmentRow
    ? (Array.isArray(commitmentRow.company) ? commitmentRow.company[0] : commitmentRow.company) as { name?: string | null } | null
    : null
  const envelopeRow = envelopeResult.data

  return {
    id: award.id as string,
    awarded_at: award.awarded_at as string,
    awarded_by_name: (awardedByResult.data?.full_name as string | null | undefined) ?? null,
    awarded_submission_id: award.awarded_submission_id as string,
    accepted_alternate_ids: (award.accepted_alternate_ids as string[] | null) ?? [],
    notes: (award.notes as string | null) ?? null,
    commitment: commitmentRow
      ? {
          id: commitmentRow.id as string,
          project_id: commitmentRow.project_id as string,
          title: commitmentRow.title as string,
          status: commitmentRow.status as string,
          total_cents: Number(commitmentRow.total_cents ?? 0),
          contract_number: (commitmentRow.contract_number as string | null) ?? null,
          retainage_percent: commitmentRow.retainage_percent != null ? Number(commitmentRow.retainage_percent) : null,
          executed_at: (commitmentRow.executed_at as string | null) ?? null,
          company_id: (commitmentRow.company_id as string | null) ?? null,
          company_name: companyJoin?.name ?? null,
        }
      : null,
    envelope: envelopeRow
      ? {
          id: envelopeRow.id as string,
          status: envelopeRow.status as string,
          sent_at: (envelopeRow.sent_at as string | null) ?? null,
          executed_at: (envelopeRow.executed_at as string | null) ?? null,
          document_id: (envelopeRow.document_id as string | null) ?? null,
        }
      : null,
  }
}

/** Tell the winner they won and everyone else who bid that they were not selected. A failure to queue a notice never undoes the award. */
async function queueAwardNotices({ supabase, orgId, bidPackage, winnerInviteId, awardId }: {
  supabase: any
  orgId: string
  bidPackage: { id: string; title: string; project_id: string | null; prospect_id: string | null; community_id: string | null; house_plan_id: string | null }
  winnerInviteId: string
  awardId: string
}) {
  try {
    const { data: org } = await supabase
      .from("orgs")
      .select("id, name, logo_url, slug")
      .eq("id", orgId)
      .maybeSingle()
    const { data: allInvites } = await supabase
      .from("bid_invites")
      .select(`
        id, org_id, bid_package_id, company_id, contact_id, invite_email, status,
        company:companies!bid_invites_org_company_fk(id, name, email),
        contact:contacts!bid_invites_org_contact_fk(id, full_name, email)
      `)
      .eq("org_id", orgId)
      .eq("bid_package_id", bidPackage.id)
      .in("status", ["sent", "viewed", "submitted"])

    const jobName = await resolveBidPackageJobName(supabase, orgId, bidPackage)
    for (const inviteRow of allInvites ?? []) {
      const inviteForEmail = mapBidInvite(inviteRow)
      const emailTo = getBidEmailRecipient(inviteForEmail)
      if (!emailTo) continue
      await enqueueBidEmail(orgId, {
        kind: "award_notice",
        to: emailTo,
        outcome: inviteForEmail.id === winnerInviteId ? "winner" : "not_selected",
        companyName: inviteForEmail.company?.name,
        contactName: inviteForEmail.contact?.full_name,
        projectName: jobName,
        bidPackageTitle: bidPackage.title,
        orgName: org?.name,
        orgLogoUrl: org?.logo_url,
        orgSlug: org?.slug,
        bidPackageId: bidPackage.id,
        inviteId: inviteForEmail.id,
        awardId,
      })
    }
  } catch (noticeError) {
    console.error("Failed to queue bid award notices", noticeError)
  }
}

export async function awardBidSubmission({
  input,
  orgId,
}: {
  input: unknown
  orgId?: string
}): Promise<BidAwardResult> {
  const parsed = awardBidSubmissionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: submission, error: submissionError } = await supabase
    .from("bid_submissions")
    .select("id, org_id, bid_invite_id, total_cents, currency, status, is_current, valid_until, scope_revision")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_submission_id)
    .maybeSingle()

  if (submissionError || !submission) {
    throw new Error("Bid submission not found")
  }

  const eligibility = bidEligibilityReason(submission)
  if (eligibility) throw new Error(eligibility)
  if (!submission.is_current) {
    throw new Error("Only the current submission can be awarded")
  }

  if (submission.total_cents == null) {
    throw new Error("Submission total is required to award")
  }

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id, company_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", submission.bid_invite_id)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

  const { data: bidPackage, error: bidPackageError } = await supabase
    .from("bid_packages")
    .select("id, project_id, prospect_id, community_id, house_plan_id, award_target, title, status, cost_code_id, budget_line_id, bond_required, scope_revision")
    .eq("org_id", resolvedOrgId)
    .eq("id", invite.bid_package_id)
    .maybeSingle()

  if (bidPackageError || !bidPackage) {
    throw new Error("Bid package not found")
  }

  if (bidPackage.status === "cancelled") {
    throw new Error("Cannot award a cancelled bid package")
  }

  const revisionReason = bidEligibilityReason(submission, bidPackage.scope_revision)
  if (revisionReason) throw new Error(revisionReason)
  const [prequal, compliance, readiness] = await Promise.all([
    getBidInvitePrequalificationWarnings([invite.company_id], resolvedOrgId),
    getBidInviteComplianceWarnings([invite.company_id], resolvedOrgId),
    getCompaniesComplianceStatus([invite.company_id], resolvedOrgId),
  ])
  const warnings = [prequal.get(invite.company_id), compliance.get(invite.company_id)].filter(Boolean)
  if (!readiness[invite.company_id]) warnings.push("Vendor compliance could not be verified")
  if (bidPackage.bond_required && !parsed.bond_verified) warnings.push("Required bond has not been reviewed")
  if (warnings.length && !parsed.readiness_exception?.trim()) throw new Error("Resolve pre-award warnings or record an authorized exception reason.")

  if (bidPackage.award_target === "price_agreement") {
    await assertProductionBidAccess(bidPackage, { supabase, orgId: resolvedOrgId, userId })
    const service = createServiceSupabaseClient()
    const { data: result, error: awardError } = await service.rpc("run_bid_award_price_agreements", {
      p_org_id: resolvedOrgId,
      p_bid_submission_id: submission.id,
      p_awarded_by: userId,
      p_notes: [parsed.notes, `Reviewed scope: ${parsed.reviewed_scope}`, `Commercial terms: ${parsed.reviewed_terms}`, parsed.readiness_exception ? `Readiness exception: ${parsed.readiness_exception}` : null].filter(Boolean).join("\n\n"),
      p_accepted_alternate_ids: parsed.accepted_alternate_ids ?? [],
      p_effective_from: parsed.effective_from ?? null,
    })
    if (awardError || !result?.award_id) throw new Error(`Failed to award bid to the price book: ${awardError?.message}`)
    // Money creates roles: an awarded price agreement makes the winner a vendor.
    await ensureVendorRoleWithClient(supabase, resolvedOrgId, invite.company_id, userId)
    const idsOf = (value: unknown) => Array.isArray(value) ? value.filter((id: unknown): id is string => typeof id === "string") : []
    const agreementIds = idsOf(result.agreement_ids)
    const displacedAgreementIds = idsOf(result.displaced_ids)
    await recordEvent({
      orgId: resolvedOrgId, actorId: userId, eventType: "bid_package.awarded_to_price_book",
      entityType: "bid_package", entityId: bidPackage.id,
      payload: { bid_package_id: bidPackage.id, bid_submission_id: submission.id, agreement_ids: agreementIds, displaced_agreement_ids: displacedAgreementIds, effective_from: parsed.effective_from ?? null },
    })
    await recordAudit({
      orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "bid_package",
      entityId: bidPackage.id, before: bidPackage, after: { ...bidPackage, status: "awarded", award_id: result.award_id },
    })
    await queueAwardNotices({ supabase, orgId: resolvedOrgId, bidPackage, winnerInviteId: invite.id, awardId: result.award_id })
    return { awardId: result.award_id, agreementIds, displacedAgreementIds }
  }

  let awardProjectId = bidPackage.project_id as string | null

  if (!bidPackage.project_id) {
    if (!bidPackage.prospect_id) {
      throw new Error("Create the project before awarding this bid. Prospect bids can receive submissions before the project exists, but awards create project commitments.")
    }

    const { data: linkedProject, error: linkedProjectError } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("prospect_id", bidPackage.prospect_id)
      .maybeSingle()

    if (linkedProjectError || !linkedProject) {
      throw new Error("Create the project before awarding this bid. Prospect bids can receive submissions before the project exists, but awards create project commitments.")
    }

    awardProjectId = linkedProject.id as string
  }

  await assertBidProjectVisibility(awardProjectId,resolvedOrgId,userId,supabase)

  // Awards create commitments — real money that must not land on an invisible
  // pricing workspace. Leveling and collecting bids is precon work; cutting
  // the subcontract waits for the job to be won.
  if (awardProjectId) {
    const { data: awardProject } = await supabase
      .from("projects")
      .select("phase")
      .eq("org_id", resolvedOrgId)
      .eq("id", awardProjectId)
      .maybeSingle()
    if (awardProject?.phase === "precon") {
      if(!await hasOwnerAward(resolvedOrgId, awardProjectId)) throw new Error("Record the signed owner contract and commercial award before committing subcontract costs.")
    }
  }

  let mappedBudgetLineId = (bidPackage.budget_line_id as string | null) ?? null
  if (!mappedBudgetLineId && awardProjectId && bidPackage.cost_code_id) {
    const budgetLine = await resolveBudgetLineForCostCode({
      supabase,
      orgId: resolvedOrgId,
      projectId: awardProjectId,
      costCodeId: bidPackage.cost_code_id as string,
    })
    mappedBudgetLineId = (budgetLine?.id as string | undefined) ?? null
  }

  if (awardProjectId !== bidPackage.project_id || mappedBudgetLineId !== bidPackage.budget_line_id) {
    const { error: linkError } = await supabase
      .from("bid_packages")
      .update({
        project_id: awardProjectId,
        budget_line_id: mappedBudgetLineId,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", bidPackage.id)

    if (linkError) {
      throw new Error(`Failed to link bid package to project budget before award: ${linkError.message}`)
    }
  }

  const { data: existingAward } = await supabase
    .from("bid_awards")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", bidPackage.id)
    .is("rescinded_at", null)
    .limit(1)
    .maybeSingle()

  if (existingAward) {
    throw new Error("This bid package has already been awarded")
  }

  const result = await runBidAwardConversion({
    orgId: resolvedOrgId,
    bidSubmissionId: submission.id as string,
    awardedBy: userId,
    notes: parsed.notes ?? null,
    acceptedAlternateIds: parsed.accepted_alternate_ids ?? [],
    reviewedScope: parsed.reviewed_scope,
    reviewedTerms: parsed.reviewed_terms,
    readinessException: parsed.readiness_exception,
  })

  // Money creates roles: the subcontract this award cut makes the winner a vendor.
  await ensureVendorRoleWithClient(supabase, resolvedOrgId, invite.company_id, userId)

  await queueAwardNotices({ supabase, orgId: resolvedOrgId, bidPackage, winnerInviteId: invite.id, awardId: result.awardId })

  return {
    awardId: result.awardId,
    commitmentId: result.commitmentId,
  }
}

export interface PriceBookAwardPreviewLine {
  costCodeId: string
  costCode: string | null
  description: string
  price: PriceLine
  replaces: Array<{
    agreementId: string
    vendorName: string
    price: PriceLine
    deltaCents: number | null
    deltaPct: number | null
    startsOn: string
    endsOn: string
  }>
}

/** What awarding this bid to the price book would replace, and when each standing price ends. Read-only: the award is `awardBidSubmission`. */
export async function previewPriceBookAward({ input, orgId }: { input: unknown; orgId?: string }): Promise<PriceBookAwardPreviewLine[]> {
  const parsed = priceBookAwardPreviewInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "bid.write"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidSubmissionAccess(parsed.bid_submission_id, resolvedOrgId, supabase)

  const { data: submission } = await supabase.from("bid_submissions").select("id, bid_invite_id")
    .eq("org_id", resolvedOrgId).eq("id", parsed.bid_submission_id).maybeSingle()
  const { data: invite } = submission
    ? await supabase.from("bid_invites").select("id, bid_package_id").eq("org_id", resolvedOrgId).eq("id", submission.bid_invite_id).maybeSingle()
    : { data: null }
  const { data: bidPackage } = invite
    ? await supabase.from("bid_packages").select("id, award_target, community_id, house_plan_id").eq("org_id", resolvedOrgId).eq("id", invite.bid_package_id).maybeSingle()
    : { data: null }
  if (!bidPackage) throw new Error("Bid package not found")
  if (bidPackage.award_target !== "price_agreement") throw new Error("Only a price-book package replaces standing prices")

  const { data: items, error: itemsError } = await supabase.from("bid_submission_items")
    .select("amount_cents, unit_rate_cents, quantity, description, scope:bid_scope_items!inner(id, cost_code_id, item_type, unit, position)")
    .eq("org_id", resolvedOrgId).eq("bid_submission_id", parsed.bid_submission_id).eq("response", "priced").not("amount_cents", "is", null)
  if (itemsError) throw new Error(`Failed to load the bid's priced lines: ${itemsError.message}`)

  const lines = (items ?? []).flatMap((item: any) => {
    const scope = Array.isArray(item.scope) ? item.scope[0] : item.scope
    if (!scope?.cost_code_id) return []
    if (scope.item_type === "alternate" && !parsed.accepted_alternate_ids.includes(scope.id)) return []
    const price: PriceLine = scope.unit == null
      ? { kind: "lump_sum", uom: null, cents: Number(item.amount_cents) }
      : { kind: "unit", uom: scope.unit, cents: Number(item.unit_rate_cents ?? Math.round(Number(item.amount_cents) / Math.max(Number(item.quantity ?? 1), 1))) }
    return [{ position: Number(scope.position ?? 0), costCodeId: String(scope.cost_code_id), costCode: null as string | null, description: String(item.description), price }]
  }).sort((a: { position: number }, b: { position: number }) => a.position - b.position)
  if (lines.length === 0) return []

  const { data: codes, error: codesError } = await supabase.from("cost_codes").select("id, code")
    .eq("org_id", resolvedOrgId).in("id", Array.from(new Set(lines.map((line: { costCodeId: string }) => line.costCodeId))))
  if (codesError) throw new Error(`Failed to load the cost codes: ${codesError.message}`)
  const codeById = new Map((codes ?? []).map((row: { id: string; code: string }) => [row.id, row.code]))
  for (const line of lines) line.costCode = codeById.get(line.costCodeId) ?? null

  const { data: standing, error: standingError } = await supabase.from("vendor_price_agreements")
    .select("*, company:companies(name)")
    .eq("org_id", resolvedOrgId).eq("status", "active").in("cost_code_id", Array.from(new Set(lines.map((line: { costCodeId: string }) => line.costCodeId))))
  if (standingError) throw new Error(`Failed to load the standing prices: ${standingError.message}`)

  return lines.map((line: { costCodeId: string; costCode: string | null; description: string; price: PriceLine }) => ({
    costCodeId: line.costCodeId,
    costCode: line.costCode,
    description: line.description,
    price: line.price,
    replaces: displacedByAward(standing ?? [], { costCodeId: line.costCodeId, communityId: bidPackage.community_id ?? null, housePlanId: bidPackage.house_plan_id ?? null }, parsed.effective_from).map(({ agreement, endsOn }) => {
      const standingPrice: PriceLine = agreement.pricing_kind === "unit"
        ? { kind: "unit", uom: agreement.uom ?? null, cents: agreement.unit_cost_cents ?? 0 }
        : { kind: "lump_sum", uom: null, cents: agreement.lump_sum_cents ?? 0 }
      const comparison = comparePrice(standingPrice, line.price)
      const company = Reflect.get(agreement, "company")
      const companyRow = Array.isArray(company) ? company[0] : company
      return {
        agreementId: agreement.id,
        vendorName: companyRow && typeof companyRow === "object" && typeof Reflect.get(companyRow, "name") === "string" ? String(Reflect.get(companyRow, "name")) : "Unknown vendor",
        price: standingPrice,
        deltaCents: comparison.comparable ? comparison.deltaCents : null,
        deltaPct: comparison.comparable ? comparison.deltaPct : null,
        startsOn: agreement.effective_from,
        endsOn,
      }
    }),
  }))
}
