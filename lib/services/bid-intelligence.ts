import { z } from "zod"
import { visibleBidPackageIds, visibleBidParentIds } from "@/lib/services/bid-intelligence-visibility"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { getBidPackage } from "@/lib/services/bids"
import { readAllRows } from "@/lib/land/paging"
import { requirePermission } from "@/lib/services/permissions"

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
  await requirePermission("bid.read", { supabase, orgId: resolvedOrgId, userId })
  await getBidPackage(bidPackageId, resolvedOrgId)

  const [submissionPage, addendumResult] = await Promise.all([
    readAllRows<{ id: string; total_cents: number; submitted_at: string | null }>((from, to) => supabase
      .from("bid_submissions")
      .select("id,total_cents,submitted_at,invite:bid_invites!bid_submissions_org_invite_fk!inner(bid_package_id)")
      .eq("org_id", resolvedOrgId)
      .eq("invite.bid_package_id", bidPackageId)
      .eq("is_current", true)
      .in("status", ["submitted", "revised"])
      .not("total_cents", "is", null)
      .order("id").range(from, to),
    { cap: 100001, pageSize: 500, label: "Unable to load complete bid comparison" }),
    supabase.from("bid_addenda").select("issued_at").eq("org_id", resolvedOrgId)
      .eq("bid_package_id", bidPackageId).order("issued_at", { ascending: false }).limit(1),
  ])
  if (submissionPage.truncated) throw new Error("Bid comparison exceeds the supported package size")
  if (addendumResult.error) throw new Error(`Unable to verify bid addenda: ${addendumResult.error.message}`)
  const latest = addendumResult.data?.[0]?.issued_at
  const latestAddendumAt = latest ? new Date(latest) : null
  const priced = submissionPage.rows.map((row) => {
    const total = Number(row.total_cents)
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("A bid total is invalid; reconcile it before comparing bids")
    return { id: row.id, total, submittedAt: row.submitted_at ? new Date(row.submitted_at) : null }
  })

  const totals = priced.map((row) => row.total).sort((a, b) => a - b)
  const middle = Math.floor(totals.length / 2)
  const median = totals.length === 0 ? null : totals.length % 2 === 1 ? totals[middle]
    : totals[middle - 1] + (totals[middle] - totals[middle - 1]) / 2
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
  await requirePermission("bid.read", { supabase, orgId: resolvedOrgId, userId })
  // Purchasing is an org/division desk role, not a house-team member: RLS on commitments hides awarded homes
  // from it. Permission and division scope are enforced above and in every filter below.
  const db = createServiceSupabaseClient()
  const access = await getDivisionAccessForUser({ orgId: resolvedOrgId, userId })
  const empty = { cost_code_id: costCodeId, award_count: 0, median_bid_to_budget_pct: null, min_award_cents: null, max_award_cents: null }
  if (access.assignedOnly && !access.divisionIds.length) return empty
  type Parent = { id: string } | Array<{ id: string }> | null
  type Package = { id: string; project_id: string | null; community_id: string | null; house_plan_id: string | null; budget_line_id: string | null; community: Parent; plan: Parent }
  type Award = { id: string; awarded_commitment_id: string | null; package: Package | Package[] | null }
  const page = await readAllRows<Award>((from, to) => {
    let query = db.from("bid_awards").select(`id,awarded_commitment_id,
      package:bid_packages!bid_awards_org_package_fk!inner(id,project_id,community_id,house_plan_id,budget_line_id,
        community:communities!bid_packages_community_id_fkey(id),
        plan:house_plans!bid_packages_house_plan_id_fkey(id))`)
      .eq("org_id", resolvedOrgId).eq("package.org_id", resolvedOrgId)
      .eq("package.community.org_id", resolvedOrgId).eq("package.plan.org_id", resolvedOrgId)
      .eq("package.cost_code_id", costCodeId).is("rescinded_at", null)
      .order("id").range(from, to)
    if (access.assignedOnly) query = query.in("package.community.division_id", access.divisionIds)
      .or(`division_id.is.null,division_id.in.(${access.divisionIds.join(",")})`, { referencedTable: "package.plan" })
      .or("project_id.not.is.null,community.not.is.null,plan.not.is.null", { referencedTable: "package" })
    return query
  }, { cap: 100001, pageSize: 500, label: "Unable to load complete award history" })
  if (page.truncated) throw new Error("Award history exceeds the supported comparison size")
  // This schema has no bid_packages → projects FK for REST embedding. Resolve
  // only this history's project references, in bounded batches, before amounts.
  const projectIds = [...new Set(page.rows.flatMap((row) => {
    const pkg = Array.isArray(row.package) ? row.package[0] : row.package
    return pkg?.project_id ? [pkg.project_id] : []
  }))]
  const visibleProjects = new Set<string>()
  for (let offset = 0; offset < projectIds.length; offset += 100) {
    let query = db.from("projects").select("id").eq("org_id", resolvedOrgId).in("id", projectIds.slice(offset, offset + 100))
    if (access.assignedOnly) query = query.in("division_id", access.divisionIds)
    const { data, error } = await query
    if (error) throw new Error(`Unable to verify award project access: ${error.message}`)
    for (const row of data ?? []) visibleProjects.add(row.id)
  }
  const present = (parent: Parent) => Boolean(Array.isArray(parent) ? parent[0] : parent)
  const rows = page.rows.flatMap((row) => {
    const pkg = Array.isArray(row.package) ? row.package[0] : row.package
    // Every populated parent must be visible, including mixed-parent legacy rows.
    if (!pkg || (pkg.project_id && !visibleProjects.has(pkg.project_id)) || (pkg.community_id && !present(pkg.community)) || (pkg.house_plan_id && !present(pkg.plan))) return []
    if (access.assignedOnly && !pkg.project_id && !pkg.community_id && !pkg.house_plan_id) return []
    return [{ ...row, package: pkg }]
  })
  if (!rows.length) return empty
  async function amounts(table: "commitments" | "budget_lines", ids: string[]) {
    const uniqueIds = [...new Set(ids)]
    const result = new Map<string, number>()
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const chunk = uniqueIds.slice(offset, offset + 100)
      const { data, error } = await db.from(table).select(table === "commitments" ? "id,total_cents" : "id,amount_cents").eq("org_id", resolvedOrgId).in("id", chunk).returns<Array<{ id: string; total_cents?: number; amount_cents?: number }>>()
      if (error) throw new Error(`Unable to load award history amounts: ${error.message}`)
      if (data?.length !== chunk.length) throw new Error("Award history references missing amounts; reconcile before comparing")
      for (const row of data) {
        const raw = table === "commitments" ? row.total_cents : row.amount_cents
        const amount = Number(raw)
        if (raw == null || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Award history contains invalid monetary amounts")
        result.set(row.id, amount)
      }
    }
    return result
  }
  const [commitmentTotals, budgetAmounts] = await Promise.all([
    amounts("commitments", rows.flatMap((row) => row.awarded_commitment_id ? [row.awarded_commitment_id] : [])),
    amounts("budget_lines", rows.flatMap((row) => row.package.budget_line_id ? [row.package.budget_line_id] : [])),
  ])
  const totals: number[] = [], ratios: number[] = []
  for (const row of rows) {
    const total = row.awarded_commitment_id ? commitmentTotals.get(row.awarded_commitment_id) : undefined
    if (total == null) continue
    totals.push(total)
    const budget = row.package.budget_line_id ? budgetAmounts.get(row.package.budget_line_id) : undefined
    if (budget != null && budget > 0) ratios.push(total / budget * 100)
  }
  ratios.sort((a,b) => a-b)
  const middle = Math.floor(ratios.length / 2)
  const median = ratios.length === 0 ? null : ratios.length % 2 ? ratios[middle] : ratios[middle - 1] + (ratios[middle] - ratios[middle - 1]) / 2
  return { cost_code_id: costCodeId, award_count: totals.length,
    median_bid_to_budget_pct: median == null ? null : Math.round(median * 10) / 10,
    min_award_cents: totals.length ? totals.reduce((a,b) => Math.min(a,b)) : null,
    max_award_cents: totals.length ? totals.reduce((a,b) => Math.max(a,b)) : null }

}

export interface VendorBidStats {
  company_id: string
  invited_count: number
  submitted_count: number
  declined_count: number
  awarded_count: number
  /** Distinct, non-rescinded price-agreement awards visible to this user. */
  production_awarded_count: number
  /** Post-award growth: approved change-order total as % of awarded totals. */
  change_order_growth_pct: number | null
}

/** Vendor behavior within the viewer's visible organization history. The headline
 * stat is change-order growth: "wins low, averages +11% in COs" is the honest
 * answer to the low bid that isn't. */
export async function getVendorBidStats(companyIds: string[], orgId?: string): Promise<Map<string, VendorBidStats>> {
  const ids = [...new Set(z.array(z.string().uuid()).max(10000).parse(companyIds))]
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context
  await requirePermission("bid.read", context)
  const access = await getDivisionAccessForUser(context)
  const stats = new Map<string, VendorBidStats>(ids.map((id) => [id, {
    company_id: id, invited_count: 0, submitted_count: 0, declined_count: 0, awarded_count: 0, production_awarded_count: 0, change_order_growth_pct: null,
  }]))
  if (!ids.length || (access.assignedOnly && !access.divisionIds.length)) return stats
  type Invite = { id: string; company_id: string; bid_package_id: string; status: string }
  type Commitment = { id: string; company_id: string; project_id: string; total_cents: number }
  const eligible: Commitment[] = []
  const productionAwards = new Map<string, Set<string>>()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const companies = ids.slice(offset, offset + 100)
    const [invites, commitments, agreements] = await Promise.all([
      readAllRows<Invite>((from, to) => supabase.from("bid_invites").select("id,company_id,bid_package_id,status")
        .eq("org_id", resolvedOrgId).in("company_id", companies).order("id").range(from, to),
      { cap: 100001, pageSize: 500, label: "Unable to load complete vendor invitation history" }),
      readAllRows<Commitment>((from, to) => supabase.from("commitments").select("id,company_id,project_id,total_cents")
        .eq("org_id", resolvedOrgId).eq("metadata->>source", "bid_award").neq("status", "canceled")
        .in("company_id", companies).order("id").range(from, to),
      { cap: 100001, pageSize: 500, label: "Unable to load complete vendor award history" }),
      readAllRows<{ id: string; company_id: string; source_bid_award_id: string }>((from, to) => supabase.from("vendor_price_agreements")
        .select("id,company_id,source_bid_award_id").eq("org_id", resolvedOrgId).in("company_id", companies)
        .not("source_bid_award_id", "is", null).order("id").range(from, to),
      { cap: 100001, pageSize: 500, label: "Unable to load complete production award history" }),
    ])
    if (invites.truncated || commitments.truncated || agreements.truncated) throw new Error("Vendor history exceeds the supported comparison size")
    // An award may produce hundreds of priced scope lines and later revisions.
    // Count its durable award identity once, not every agreement row.
    const awardIds = [...new Set(agreements.rows.map((row) => row.source_bid_award_id))]
    const awards = new Map<string, { id: string; bid_package_id: string; rescinded_at: string | null }>()
    for (let index = 0; index < awardIds.length; index += 100) {
      const chunk = awardIds.slice(index, index + 100)
      const { data, error } = await supabase.from("bid_awards").select("id,bid_package_id,rescinded_at")
        .eq("org_id", resolvedOrgId).in("id", chunk)
      if (error) throw new Error(`Unable to verify production award history: ${error.message}`)
      if (data?.length !== chunk.length) throw new Error("Production history references missing awards")
      for (const row of data) awards.set(row.id, row)
    }
    const [packages, projects] = await Promise.all([
      visibleBidPackageIds([...invites.rows.map((row) => row.bid_package_id), ...[...awards.values()].filter((row) => !row.rescinded_at).map((row) => row.bid_package_id)], context, access),
      visibleBidParentIds("projects", commitments.rows.map((row) => row.project_id), context, access),
    ])
    for (const invite of invites.rows) {
      if (!packages.has(invite.bid_package_id)) continue
      const entry = stats.get(invite.company_id)!
      entry.invited_count++
      if (invite.status === "submitted") entry.submitted_count++
      if (invite.status === "declined") entry.declined_count++
    }
    for (const agreement of agreements.rows) {
      const award = awards.get(agreement.source_bid_award_id)
      if (!award || award.rescinded_at || !packages.has(award.bid_package_id)) continue
      const companyAwards = productionAwards.get(agreement.company_id) ?? new Set<string>()
      companyAwards.add(award.id)
      productionAwards.set(agreement.company_id, companyAwards)
    }
    eligible.push(...commitments.rows.filter((row) => projects.has(row.project_id)))
  }
  for (const [company, awards] of productionAwards) stats.get(company)!.production_awarded_count = awards.size
  function cents(raw: unknown, signed = false) {
    const value = Number(raw)
    if (raw == null || !Number.isSafeInteger(value) || (!signed && value < 0)) throw new Error("Vendor history contains invalid monetary amounts")
    return BigInt(value)
  }
  const awardTotals = new Map<string, bigint>()
  const companyByCommitment = new Map<string, string>()
  for (const commitment of eligible) {
    const entry = stats.get(commitment.company_id)!
    entry.awarded_count++
    awardTotals.set(entry.company_id, (awardTotals.get(entry.company_id) ?? BigInt(0)) + cents(commitment.total_cents))
    companyByCommitment.set(commitment.id, entry.company_id)
  }
  const coTotals = new Map<string, bigint>()
  const commitmentIds = [...companyByCommitment.keys()]
  for (let offset = 0; offset < commitmentIds.length; offset += 100) {
    const result = await readAllRows<{ id: string; commitment_id: string; total_cents: number }>((from, to) => supabase
      .from("commitment_change_orders").select("id,commitment_id,total_cents")
      .eq("org_id", resolvedOrgId).in("commitment_id", commitmentIds.slice(offset, offset + 100))
      .in("status", ["approved", "complete"]).order("id").range(from, to),
    { cap: 100001, pageSize: 500, label: "Unable to load complete vendor change-order history" })
    if (result.truncated) throw new Error("Vendor change-order history exceeds the supported comparison size")
    for (const row of result.rows) {
      const company = companyByCommitment.get(row.commitment_id)
      if (!company) throw new Error("Vendor change-order history has an invalid commitment reference")
      coTotals.set(company, (coTotals.get(company) ?? BigInt(0)) + cents(row.total_cents, true))
    }
  }
  for (const [company, total] of awardTotals) {
    if (total <= BigInt(0)) continue
    const change = coTotals.get(company) ?? BigInt(0)
    const absolute = change < BigInt(0) ? -change : change
    const tenths = Number((absolute * BigInt(1000) + total / BigInt(2)) / total)
    if (!Number.isSafeInteger(tenths)) throw new Error("Vendor growth exceeds the supported reporting range")
    stats.get(company)!.change_order_growth_pct = (change < BigInt(0) ? -tenths : tenths) / 10
  }
  return stats
}
