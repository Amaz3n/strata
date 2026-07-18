import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"

/**
 * Bid intelligence, in order of trustworthiness:
 *
 * 1. Within-package signals — the other bids on the same package are the only
 *    perfectly scope-matched comparison set. Outliers here mean missed scope
 *    or a change-order strategy, and staleness against addenda is a fact.
 * 2. Own-history — bid-vs-budget ratios for the org's past awards on the same
 *    cost code. The budget is the GC's own encoding of scope intensity, so
 *    deviation-from-budget is scope-adjusted for free.
 * 3. Vendor behavior — coverage, decline rate, and post-award change-order
 *    growth per company. Scope-independent by construction.
 *
 * The cross-org market pool lives in the record_bid_submission_benchmark RPC
 * (arc_bid_benchmark_facts) and rides on submissions as a stored snapshot.
 *
 * None of these ever say "good bid" — only "unusual, given X", with X stated.
 */

export interface BidOutlierSignal {
  bid_submission_id: string
  total_cents: number
  deviation_from_median_pct: number | null
  is_low_outlier: boolean
  is_stale_vs_addenda: boolean
}

export interface PackageIntelligence {
  bid_package_id: string
  sample_size: number
  median_cents: number | null
  spread_pct: number | null
  signals: BidOutlierSignal[]
}

/** Flags a bid as a low outlier when it sits ≥20% under the median of at
 * least three peer bids on the same package — the "walk the scope before you
 * award this" alarm. */
export async function getPackageIntelligence(bidPackageId: string, orgId?: string): Promise<PackageIntelligence> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const [{ data: invites }, { data: addenda }] = await Promise.all([
    supabase
      .from("bid_invites")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId),
    supabase
      .from("bid_addenda")
      .select("issued_at")
      .eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId)
      .order("issued_at", { ascending: false })
      .limit(1),
  ])

  const inviteIds = (invites ?? []).map((row: any) => row.id as string)
  const latestAddendumAt = addenda?.[0]?.issued_at ? new Date(addenda[0].issued_at as string) : null

  if (inviteIds.length === 0) {
    return { bid_package_id: bidPackageId, sample_size: 0, median_cents: null, spread_pct: null, signals: [] }
  }

  const { data: submissions } = await supabase
    .from("bid_submissions")
    .select("id, total_cents, submitted_at, status")
    .eq("org_id", resolvedOrgId)
    .eq("is_current", true)
    .in("status", ["submitted", "revised"])
    .not("total_cents", "is", null)
    .in("bid_invite_id", inviteIds)

  const priced = (submissions ?? []).map((row: any) => ({
    id: row.id as string,
    total: Number(row.total_cents),
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string) : null,
  }))

  const totals = priced.map((row) => row.total).sort((a, b) => a - b)
  const median = totals.length > 0 ? totals[Math.floor((totals.length - 1) / 2)] : null
  const spread =
    totals.length >= 2 && totals[0] > 0
      ? Math.round(((totals[totals.length - 1] - totals[0]) / totals[0]) * 1000) / 10
      : null

  const signals: BidOutlierSignal[] = priced.map((row) => {
    const deviation =
      median != null && median > 0 ? Math.round(((row.total - median) / median) * 1000) / 10 : null
    return {
      bid_submission_id: row.id,
      total_cents: row.total,
      deviation_from_median_pct: deviation,
      is_low_outlier: totals.length >= 3 && deviation != null && deviation <= -20,
      is_stale_vs_addenda:
        !!latestAddendumAt && !!row.submittedAt && row.submittedAt < latestAddendumAt,
    }
  })

  return {
    bid_package_id: bidPackageId,
    sample_size: priced.length,
    median_cents: median,
    spread_pct: spread,
    signals,
  }
}

export interface CostCodeBidHistory {
  cost_code_id: string
  award_count: number
  median_bid_to_budget_pct: number | null
  min_award_cents: number | null
  max_award_cents: number | null
}

/** The org's own award history for a cost code: how awards landed against
 * budgets. Feeds "your roofing awards land at 92–105% of budget" annotations
 * when setting budgets or judging a new bid. */
export async function getCostCodeBidHistory(costCodeId: string, orgId?: string): Promise<CostCodeBidHistory> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data: awards } = await supabase
    .from("bid_awards")
    .select(
      `
      id, awarded_commitment_id,
      package:bid_packages!bid_awards_org_package_fk(id, cost_code_id, budget_line_id)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .is("rescinded_at", null)
    .eq("bid_packages.cost_code_id", costCodeId)

  const rows = (awards ?? []).filter((row: any) => {
    const pkg = Array.isArray(row.package) ? row.package[0] : row.package
    return pkg?.cost_code_id === costCodeId
  })

  if (rows.length === 0) {
    return { cost_code_id: costCodeId, award_count: 0, median_bid_to_budget_pct: null, min_award_cents: null, max_award_cents: null }
  }

  const commitmentIds = rows
    .map((row: any) => row.awarded_commitment_id as string | null)
    .filter((id: string | null): id is string => !!id)
  const budgetLineIds = rows
    .map((row: any) => {
      const pkg = Array.isArray(row.package) ? row.package[0] : row.package
      return (pkg?.budget_line_id as string | null) ?? null
    })
    .filter((id: string | null): id is string => !!id)

  const [{ data: commitments }, { data: budgetLines }] = await Promise.all([
    commitmentIds.length > 0
      ? supabase.from("commitments").select("id, total_cents").eq("org_id", resolvedOrgId).in("id", commitmentIds)
      : Promise.resolve({ data: [] as any[] }),
    budgetLineIds.length > 0
      ? supabase.from("budget_lines").select("id, amount_cents").eq("org_id", resolvedOrgId).in("id", budgetLineIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const commitmentTotals = new Map((commitments ?? []).map((row: any) => [row.id as string, Number(row.total_cents ?? 0)]))
  const budgetAmounts = new Map((budgetLines ?? []).map((row: any) => [row.id as string, Number(row.amount_cents ?? 0)]))

  const awardTotals: number[] = []
  const ratios: number[] = []
  for (const row of rows) {
    const pkg = Array.isArray((row as any).package) ? (row as any).package[0] : (row as any).package
    const total = (row as any).awarded_commitment_id
      ? commitmentTotals.get((row as any).awarded_commitment_id as string)
      : undefined
    if (total == null || total <= 0) continue
    awardTotals.push(total)
    const budget = pkg?.budget_line_id ? budgetAmounts.get(pkg.budget_line_id as string) : undefined
    if (budget != null && budget > 0) {
      ratios.push((total / budget) * 100)
    }
  }

  const sortedRatios = [...ratios].sort((a, b) => a - b)
  return {
    cost_code_id: costCodeId,
    award_count: awardTotals.length,
    median_bid_to_budget_pct:
      sortedRatios.length > 0 ? Math.round(sortedRatios[Math.floor((sortedRatios.length - 1) / 2)] * 10) / 10 : null,
    min_award_cents: awardTotals.length > 0 ? Math.min(...awardTotals) : null,
    max_award_cents: awardTotals.length > 0 ? Math.max(...awardTotals) : null,
  }
}

export interface VendorBidStats {
  company_id: string
  invited_count: number
  submitted_count: number
  declined_count: number
  awarded_count: number
  /** Post-award growth: approved change-order total as % of awarded totals. */
  change_order_growth_pct: number | null
}

/** Scope-independent vendor behavior across the org's history. The headline
 * stat is change-order growth: "wins low, averages +11% in COs" is the honest
 * answer to the low bid that isn't. */
export async function getVendorBidStats(companyIds: string[], orgId?: string): Promise<Map<string, VendorBidStats>> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const stats = new Map<string, VendorBidStats>()
  if (companyIds.length === 0) return stats

  for (const companyId of companyIds) {
    stats.set(companyId, {
      company_id: companyId,
      invited_count: 0,
      submitted_count: 0,
      declined_count: 0,
      awarded_count: 0,
      change_order_growth_pct: null,
    })
  }

  const [{ data: invites }, { data: awardCommitments }] = await Promise.all([
    supabase
      .from("bid_invites")
      .select("company_id, status")
      .eq("org_id", resolvedOrgId)
      .in("company_id", companyIds),
    supabase
      .from("commitments")
      .select("id, company_id, total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("metadata->>source", "bid_award")
      .in("company_id", companyIds),
  ])

  for (const invite of invites ?? []) {
    const entry = stats.get(invite.company_id as string)
    if (!entry) continue
    entry.invited_count += 1
    if (invite.status === "submitted") entry.submitted_count += 1
    if (invite.status === "declined") entry.declined_count += 1
  }

  const commitmentsByCompany = new Map<string, Array<{ id: string; total: number }>>()
  for (const commitment of awardCommitments ?? []) {
    const list = commitmentsByCompany.get(commitment.company_id as string) ?? []
    list.push({ id: commitment.id as string, total: Number(commitment.total_cents ?? 0) })
    commitmentsByCompany.set(commitment.company_id as string, list)
  }

  const allCommitmentIds = [...commitmentsByCompany.values()].flat().map((row) => row.id)
  const coTotalsByCommitment = new Map<string, number>()
  if (allCommitmentIds.length > 0) {
    const { data: changeOrders } = await supabase
      .from("commitment_change_orders")
      .select("commitment_id, total_cents, status")
      .eq("org_id", resolvedOrgId)
      .in("commitment_id", allCommitmentIds)
      .in("status", ["approved", "complete"])
    for (const co of changeOrders ?? []) {
      coTotalsByCommitment.set(
        co.commitment_id as string,
        (coTotalsByCommitment.get(co.commitment_id as string) ?? 0) + Number(co.total_cents ?? 0),
      )
    }
  }

  for (const [companyId, commitments] of commitmentsByCompany) {
    const entry = stats.get(companyId)
    if (!entry) continue
    entry.awarded_count = commitments.length
    const awardedTotal = commitments.reduce((sum, row) => sum + row.total, 0)
    const coTotal = commitments.reduce((sum, row) => sum + (coTotalsByCommitment.get(row.id) ?? 0), 0)
    if (awardedTotal > 0) {
      entry.change_order_growth_pct = Math.round((coTotal / awardedTotal) * 1000) / 10
    }
  }

  return stats
}
