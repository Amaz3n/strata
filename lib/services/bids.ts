import { createHmac, randomBytes } from "crypto"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  createBidPackageInputSchema,
  updateBidPackageInputSchema,
  createBidInviteInputSchema,
  createBidAddendumInputSchema,
  awardBidSubmissionInputSchema,
  rescindBidAwardInputSchema,
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

export interface BidPackage {
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

function requireBidPortalSecret() {
  const secret = process.env.BID_PORTAL_SECRET
  if (!secret) {
    throw new Error("Missing BID_PORTAL_SECRET environment variable")
  }
  return secret
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
  const secret = requireBidPortalSecret()
  const now = new Date().toISOString()
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")

  const { data: invite, error: inviteError } = await supabase
    .from("bid_invites")
    .select("id, bid_package_id, status")
    .eq("org_id", orgId)
    .eq("id", inviteId)
    .maybeSingle()

  if (inviteError || !invite) {
    throw new Error("Bid invite not found")
  }

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
    .select("id, project_id, prospect_id, cost_code_id, budget_line_id")
    .eq("org_id", orgId)
    .eq("id", bidPackageId)
    .maybeSingle()
  if (error || !bidPackage) {
    throw new Error("Bid package not found in this organization")
  }
  return bidPackage
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

  const project = await ensureProjectInOrg(projectId, resolvedOrgId, supabase)

  let query = supabase
    .from("bid_packages")
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name),
      bid_invites!bid_invites_org_package_fk(count)
    `)
    .eq("org_id", resolvedOrgId)

  if (project.prospect_id) {
    query = query.or(`project_id.eq.${projectId},and(project_id.is.null,prospect_id.eq.${project.prospect_id})`)
  } else {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query.order("created_at", { ascending: false })

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
}

/**
 * Current, priced sub bids across a prospect's bid packages — offered in the
 * estimate builder so a line's cost basis can come straight from a real quote.
 */
export async function listProspectBidQuotes(prospectId: string, orgId?: string): Promise<ProspectBidQuote[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureProspectInOrg(prospectId, resolvedOrgId, supabase)

  const { data: packages, error: packagesError } = await supabase
    .from("bid_packages")
    .select("id, title, trade")
    .eq("org_id", resolvedOrgId)
    .eq("prospect_id", prospectId)

  if (packagesError) {
    throw new Error(`Failed to load prospect bid packages: ${packagesError.message}`)
  }
  if (!packages || packages.length === 0) return []

  const packageById = new Map(packages.map((row: any) => [row.id as string, row]))

  const { data: submissions, error: submissionsError } = await supabase
    .from("bid_submissions")
    .select(
      `id, total_cents, is_current, status,
       invite:bid_invites!inner(bid_package_id, company:companies(name))`,
    )
    .eq("org_id", resolvedOrgId)
    .eq("is_current", true)
    .not("total_cents", "is", null)
    .in(
      "bid_invites.bid_package_id",
      packages.map((row: any) => row.id as string),
    )

  if (submissionsError) {
    throw new Error(`Failed to load prospect bid quotes: ${submissionsError.message}`)
  }

  return (submissions ?? [])
    .map((row: any) => {
      const invite = Array.isArray(row.invite) ? row.invite[0] : row.invite
      const pkg = invite ? packageById.get(invite.bid_package_id as string) : null
      if (!pkg) return null
      const company = invite?.company
        ? Array.isArray(invite.company)
          ? invite.company[0]
          : invite.company
        : null
      return {
        submission_id: row.id as string,
        bid_package_id: pkg.id as string,
        package_title: pkg.title as string,
        trade: (pkg.trade as string | null) ?? null,
        company_name: (company?.name as string | undefined) ?? null,
        total_cents: row.total_cents as number,
      }
    })
    .filter((row): row is ProspectBidQuote => row !== null)
    .sort((a, b) => a.package_title.localeCompare(b.package_title) || a.total_cents - b.total_cents)
}

export async function listProspectBidPackages(prospectId: string, orgId?: string): Promise<BidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureProspectInOrg(prospectId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_packages")
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name),
      bid_invites!bid_invites_org_package_fk(count)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("prospect_id", prospectId)
    // Converted packages carry a project_id and live on the project's bids
    // tab — one home per package, never both lists.
    .is("project_id", null)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list bid packages: ${error.message}`)
  }

  return decorateBidPackageSummaries(supabase, resolvedOrgId, (data ?? []).map(mapBidPackage))
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
export async function listOrgBidPackages(orgId?: string): Promise<OrgBidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("bid_packages")
    .select(`
      ${BID_PACKAGE_COLUMNS},
      cost_code:cost_codes(code, name),
      bid_invites!bid_invites_org_package_fk(count)
    `)
    .eq("org_id", resolvedOrgId)
    .neq("status", "cancelled")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to list bid packages: ${error.message}`)
  }

  const packages = await decorateBidPackageSummaries(supabase, resolvedOrgId, (data ?? []).map(mapBidPackage))

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

export async function listCommunityBidPackages(communityId: string, orgId?: string): Promise<BidPackage[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["bid.read", "price_book.read"], { supabase, orgId: resolvedOrgId, userId })
  const { data: community } = await supabase.from("communities").select("id").eq("org_id", resolvedOrgId).eq("id", communityId).maybeSingle()
  if (!community) throw new Error("Community not found")
  const { data, error } = await supabase.from("bid_packages").select(`
    ${BID_PACKAGE_COLUMNS}, cost_code:cost_codes(code, name), bid_invites!bid_invites_org_package_fk(count)
  `).eq("org_id", resolvedOrgId).eq("community_id", communityId).order("due_at", { ascending: false }).limit(200)
  if (error) throw new Error(`Failed to list community bid packages: ${error.message}`)
  return decorateBidPackageSummaries(supabase, resolvedOrgId, (data ?? []).map(mapBidPackage))
}

export async function listBidScopeItems(bidPackageId: string, orgId?: string): Promise<BidScopeItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(bidPackageId, resolvedOrgId, supabase)

  const { data, error } = await supabase
    .from("bid_scope_items")
    .select("id, org_id, bid_package_id, position, item_type, description, details, quantity, unit, budget_cents, cost_code_id, created_at, updated_at")
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
  if (pkgStatusRow?.status === "awarded") {
    throw new Error("Scope cannot change after award — rescind the award first")
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
      project_id: parsed.project_id ?? null,
      prospect_id: parsed.prospect_id ?? null,
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
  if (parsed.award_target !== undefined) updates.award_target = parsed.award_target
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

  if (parsed.status && ["sent", "open"].includes(parsed.status) && existing.project_id) {
    await ensureProjectBiddingStatus(existing.project_id, resolvedOrgId, supabase)
  }

  if (parsed.status && parsed.status !== existing.status) {
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "bid_package_status_changed",
      entityType: "bid_package",
      entityId: data.id as string,
      payload: { from: existing.status, to: parsed.status },
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
  const prequalificationWarnings = await getBidInvitePrequalificationWarnings(invites.map((invite) => invite.company_id), resolvedOrgId)

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
      .from("external_portal_account_grants")
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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

        companyId = newCompany.id
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

      let bidLink: string | null = null
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
            await enqueueBidEmail(resolvedOrgId, {
              kind: "invite",
              to: emailTo,
              companyName: invite.company?.name,
              contactName: invite.contact?.full_name,
              projectName: jobName,
              bidPackageTitle: bidPackage.title,
              trade: bidPackage.trade,
              dueDate: bidPackage.due_at,
              orgName: org?.name,
              orgLogoUrl: org?.logo_url,
              bidLink,
              orgSlug: org?.slug,
              bidPackageId: parsed.bid_package_id,
              inviteId: invite.id,
            })
            emailsSent++
          } catch (emailError) {
            console.error("Failed to queue bid invite email:", emailError)
            // Don't fail the invite creation if email fails
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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

  await enqueueBidEmail(resolvedOrgId, {
    kind: "invite",
    to: emailTo,
    companyName: invite.company?.name,
    contactName: invite.contact?.full_name,
    projectName: jobName,
    bidPackageTitle: bidPackage?.title ?? "Bid package",
    trade: bidPackage?.trade ?? null,
    dueDate: bidPackage?.due_at ?? null,
    orgName: org?.name,
    orgLogoUrl: org?.logo_url,
    bidLink: bidLink.url,
    orgSlug: org?.slug,
    bidPackageId: bidPackage?.id ?? invite.bid_package_id,
    inviteId,
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

export async function listBidAddenda(bidPackageId: string, orgId?: string): Promise<BidAddendum[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

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
}): Promise<BidAddendum> {
  const parsed = createBidAddendumInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  await ensureBidPackageInOrg(parsed.bid_package_id, resolvedOrgId, supabase)

  const { data: existing } = await supabase
    .from("bid_addenda")
    .select("number")
    .eq("org_id", resolvedOrgId)
    .eq("bid_package_id", parsed.bid_package_id)
    .order("number", { ascending: false })
    .limit(1)

  const nextNumber = (existing?.[0]?.number ?? 0) + 1

  const { data, error } = await supabase
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

  // Fetch bid package details for email
  try {
    const { data: bidPackage } = await supabase
      .from("bid_packages")
      .select("id, project_id, prospect_id, title, trade")
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.bid_package_id)
      .maybeSingle()

    if (bidPackage) {
      const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, bidPackage)

      // Fetch org details for email
      const { data: org } = await supabase
        .from("orgs")
        .select("id, name, logo_url, slug")
        .eq("id", resolvedOrgId)
        .maybeSingle()

      // Fetch active subcontractor invites on the bid package to notify them
      const { data: invites } = await supabase
        .from("bid_invites")
        .select(`
          id, org_id, bid_package_id, company_id, contact_id, invite_email, status,
          company:companies!bid_invites_org_company_fk(id, name, email),
          contact:contacts!bid_invites_org_contact_fk(id, full_name, email)
        `)
        .eq("org_id", resolvedOrgId)
        .eq("bid_package_id", parsed.bid_package_id)
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
            })

            await enqueueBidEmail(resolvedOrgId, {
              kind: "addendum",
              to: emailTo,
              companyName: invite.company?.name,
              contactName: invite.contact?.full_name,
              projectName: jobName,
              bidPackageTitle: bidPackage.title,
              addendumNumber: nextNumber,
              addendumTitle: parsed.title,
              addendumMessage: parsed.message,
              orgName: org?.name,
              orgLogoUrl: org?.logo_url,
              bidLink,
              orgSlug: org?.slug,
              bidPackageId: parsed.bid_package_id,
              inviteId: invite.id,
              addendumId: data.id,
            })
          } catch (emailError) {
            console.error(`Failed to queue bid addendum email to ${emailTo}:`, emailError)
          }
        }
      }
    }
  } catch (emailBlockError) {
    console.error("Failed to queue bid addendum email notifications:", emailBlockError)
  }

  return mapBidAddendum(data)
}

export async function listBidSubmissions(bidPackageId: string, orgId?: string): Promise<BidSubmission[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

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

  const awardedSubmissionId = (award as any)?.awarded_submission_id as string | undefined
  const rows = (data ?? []).map((row) => ({
    ...mapBidSubmission({ ...row, is_awarded: awardedSubmissionId === row.id }),
    invite: inviteById.get(row.bid_invite_id as string),
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

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

export interface BidAwardRescindResult {
  bidPackageId: string
  commitmentId: string | null
  commitmentCanceled: boolean
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
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
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
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "bid_award",
    entityId: award.id,
    after: { rescinded: true, reason: parsed.reason },
  })

  return {
    bidPackageId: parsed.bid_package_id,
    commitmentId: (row?.commitment_id as string | null) ?? null,
    commitmentCanceled: !!row?.commitment_canceled,
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
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", rfiId)
    .maybeSingle()

  if (error || !rfi) {
    throw new Error("RFI not found")
  }

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
    .select("id, org_id, bid_invite_id, total_cents, currency, status, is_current")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.bid_submission_id)
    .maybeSingle()

  if (submissionError || !submission) {
    throw new Error("Bid submission not found")
  }

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
    .select("id, project_id, prospect_id, community_id, house_plan_id, award_target, title, status, cost_code_id, budget_line_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", invite.bid_package_id)
    .maybeSingle()

  if (bidPackageError || !bidPackage) {
    throw new Error("Bid package not found")
  }

  if (bidPackage.status === "cancelled") {
    throw new Error("Cannot award a cancelled bid package")
  }

  if (bidPackage.award_target === "price_agreement") {
    const service = createServiceSupabaseClient()
    const { data: result, error: awardError } = await service.rpc("run_bid_award_price_agreements", {
      p_org_id: resolvedOrgId,
      p_bid_submission_id: submission.id,
      p_awarded_by: userId,
      p_notes: parsed.notes ?? null,
      p_accepted_alternate_ids: parsed.accepted_alternate_ids ?? [],
    })
    if (awardError || !result?.award_id) throw new Error(`Failed to award bid to the price book: ${awardError?.message}`)
    const agreementIds = Array.isArray(result.agreement_ids)
      ? result.agreement_ids.filter((id: unknown): id is string => typeof id === "string")
      : []
    await recordEvent({
      orgId: resolvedOrgId, actorId: userId, eventType: "bid_package.awarded_to_price_book",
      entityType: "bid_package", entityId: bidPackage.id,
      payload: { bid_package_id: bidPackage.id, bid_submission_id: submission.id, agreement_ids: agreementIds },
    })
    await recordAudit({
      orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "bid_package",
      entityId: bidPackage.id, before: bidPackage, after: { ...bidPackage, status: "awarded", award_id: result.award_id },
    })
    return { awardId: result.award_id, agreementIds }
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
  })

  try {
    const { data: org } = await supabase
      .from("orgs")
      .select("id, name, logo_url, slug")
      .eq("id", resolvedOrgId)
      .maybeSingle()
    const { data: allInvites } = await supabase
      .from("bid_invites")
      .select(`
        id, org_id, bid_package_id, company_id, contact_id, invite_email, status,
        company:companies!bid_invites_org_company_fk(id, name, email),
        contact:contacts!bid_invites_org_contact_fk(id, full_name, email)
      `)
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackage.id)
      .in("status", ["sent", "viewed", "submitted"])

    const jobName = await resolveBidPackageJobName(supabase, resolvedOrgId, bidPackage)
    for (const inviteRow of allInvites ?? []) {
      const inviteForEmail = mapBidInvite(inviteRow)
      const emailTo = getBidEmailRecipient(inviteForEmail)
      if (!emailTo) continue
      const isWinner = inviteForEmail.id === invite.id
      await enqueueBidEmail(resolvedOrgId, {
        kind: "award_notice",
        to: emailTo,
        outcome: isWinner ? "winner" : "not_selected",
        companyName: inviteForEmail.company?.name,
        contactName: inviteForEmail.contact?.full_name,
        projectName: jobName,
        bidPackageTitle: bidPackage.title,
        orgName: org?.name,
        orgLogoUrl: org?.logo_url,
        orgSlug: org?.slug,
        bidPackageId: bidPackage.id,
        inviteId: inviteForEmail.id,
        awardId: result.awardId,
      })
    }
  } catch (noticeError) {
    console.error("Failed to queue bid award notices", noticeError)
  }

  return {
    awardId: result.awardId,
    commitmentId: result.commitmentId,
  }
}
