import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"

export interface VendorScorecardSummary {
  id: string
  company_id: string
  period_start: string
  period_end: string
  score: number
  rating_label: string
  on_time_bill_rate?: number | null
  bid_response_rate?: number | null
  bid_win_rate?: number | null
  change_order_rate?: number | null
  daily_log_mention_count: number
  warranty_callback_count: number
  invoice_issue_count: number
  committed_cents: number
  billed_cents: number
  paid_cents: number
  computed_at: string
}

export interface VendorTaxReadinessSummary {
  id: string
  company_id: string
  tax_year: number
  requires_1099: boolean
  w9_status: "ready" | "missing" | "pending_review" | "rejected" | "not_required"
  paid_cents: number
  bill_count: number
  last_bill_date?: string | null
  threshold_cents?: number | null
}

export interface DirectoryIntelligenceSummary {
  scorecardCount: number
  averageScore: number | null
  openMergeCandidateCount: number
  missingW9Count: number
  readyW9Count: number
  taxYear: number
}

export interface DirectoryIntelligenceByCompany {
  scorecardsByCompanyId: Record<string, VendorScorecardSummary>
  taxReadinessByCompanyId: Record<string, VendorTaxReadinessSummary>
}

function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapScorecard(row: any): VendorScorecardSummary {
  return {
    id: row.id,
    company_id: row.company_id,
    period_start: row.period_start,
    period_end: row.period_end,
    score: toNumber(row.score),
    rating_label: row.rating_label ?? "Needs data",
    on_time_bill_rate: row.on_time_bill_rate == null ? null : toNumber(row.on_time_bill_rate),
    bid_response_rate: row.bid_response_rate == null ? null : toNumber(row.bid_response_rate),
    bid_win_rate: row.bid_win_rate == null ? null : toNumber(row.bid_win_rate),
    change_order_rate: row.change_order_rate == null ? null : toNumber(row.change_order_rate),
    daily_log_mention_count: toNumber(row.daily_log_mention_count),
    warranty_callback_count: toNumber(row.warranty_callback_count),
    invoice_issue_count: toNumber(row.invoice_issue_count),
    committed_cents: toNumber(row.committed_cents),
    billed_cents: toNumber(row.billed_cents),
    paid_cents: toNumber(row.paid_cents),
    computed_at: row.computed_at,
  }
}

function mapTaxReadiness(row: any): VendorTaxReadinessSummary {
  const metadata = row.metadata ?? {}
  return {
    id: row.id,
    company_id: row.company_id,
    tax_year: toNumber(row.tax_year),
    requires_1099: Boolean(row.requires_1099),
    w9_status: row.w9_status ?? "missing",
    paid_cents: toNumber(row.paid_cents),
    bill_count: toNumber(row.bill_count),
    last_bill_date: row.last_bill_date ?? null,
    threshold_cents: metadata.threshold_cents == null ? null : toNumber(metadata.threshold_cents),
  }
}

export async function getDirectoryIntelligenceForCompanies(
  companyIds: string[],
): Promise<DirectoryIntelligenceByCompany> {
  const ids = Array.from(new Set(companyIds.filter(Boolean)))
  if (ids.length === 0) {
    return { scorecardsByCompanyId: {}, taxReadinessByCompanyId: {} }
  }

  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId,
    userId,
  })

  const taxYear = new Date().getFullYear()
  const [scorecardsResult, taxResult] = await Promise.all([
    supabase
      .from("vendor_scorecards")
      .select("*")
      .eq("org_id", orgId)
      .in("company_id", ids)
      .order("period_end", { ascending: false })
      .order("computed_at", { ascending: false }),
    supabase
      .from("vendor_tax_readiness")
      .select("*")
      .eq("org_id", orgId)
      .eq("tax_year", taxYear)
      .in("company_id", ids)
      .order("last_checked_at", { ascending: false }),
  ])

  if (scorecardsResult.error) {
    throw new Error(`Failed to load vendor scorecards: ${scorecardsResult.error.message}`)
  }
  if (taxResult.error) {
    throw new Error(`Failed to load vendor tax readiness: ${taxResult.error.message}`)
  }

  const scorecardsByCompanyId: Record<string, VendorScorecardSummary> = {}
  for (const row of scorecardsResult.data ?? []) {
    if (!scorecardsByCompanyId[row.company_id]) {
      scorecardsByCompanyId[row.company_id] = mapScorecard(row)
    }
  }

  const taxReadinessByCompanyId: Record<string, VendorTaxReadinessSummary> = {}
  for (const row of taxResult.data ?? []) {
    if (!taxReadinessByCompanyId[row.company_id]) {
      taxReadinessByCompanyId[row.company_id] = mapTaxReadiness(row)
    }
  }

  return { scorecardsByCompanyId, taxReadinessByCompanyId }
}

export async function getDirectoryIntelligenceSummary(): Promise<DirectoryIntelligenceSummary> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId,
    userId,
  })

  const taxYear = new Date().getFullYear()
  const [
    scorecardsResult,
    mergeResult,
    missingW9Result,
    readyW9Result,
  ] = await Promise.all([
    supabase
      .from("vendor_scorecards")
      .select("score", { count: "exact" })
      .eq("org_id", orgId),
    supabase
      .from("directory_merge_candidates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "open"),
    supabase
      .from("vendor_tax_readiness")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("tax_year", taxYear)
      .eq("requires_1099", true)
      .in("w9_status", ["missing", "rejected"]),
    supabase
      .from("vendor_tax_readiness")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("tax_year", taxYear)
      .eq("requires_1099", true)
      .eq("w9_status", "ready"),
  ])

  const firstError =
    scorecardsResult.error ||
    mergeResult.error ||
    missingW9Result.error ||
    readyW9Result.error
  if (firstError) {
    throw new Error(`Failed to load directory intelligence summary: ${firstError.message}`)
  }

  const scores = (scorecardsResult.data ?? []).map((row: any) => toNumber(row.score))
  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
      : null

  return {
    scorecardCount: scorecardsResult.count ?? scores.length,
    averageScore,
    openMergeCandidateCount: mergeResult.count ?? 0,
    missingW9Count: missingW9Result.count ?? 0,
    readyW9Count: readyW9Result.count ?? 0,
    taxYear,
  }
}

export async function refreshDirectoryIntelligenceForCurrentOrg() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["org.member", "directory.write"], {
    supabase,
    orgId,
    userId,
  })

  const serviceSupabase = createServiceSupabaseClient()
  const { data, error } = await serviceSupabase.rpc("refresh_directory_intelligence", {
    p_org_id: orgId,
  })

  if (error) {
    throw new Error(`Failed to refresh directory intelligence: ${error.message}`)
  }

  return data as { scorecards?: number; tax_readiness?: number; merge_candidates?: number } | null
}
