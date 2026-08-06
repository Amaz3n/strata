import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import { getComplianceRules } from "@/lib/services/compliance"
import { requireOrgContext } from "@/lib/services/context"
import { listCostCodes } from "@/lib/services/cost-codes"
import { orgBillsInboundAddress } from "@/lib/services/payables-email-ingest"
import { requireAnyPermission } from "@/lib/services/permissions"
import {
  applyProjectIdScope,
  applyReportingExclusion,
  getReportingExcludedProjectIds,
} from "@/lib/services/reporting-scope"
import {
  hydrateVendorBills,
  vendorBillSelect,
  type VendorBillSummary,
} from "@/lib/services/vendor-bills"
import {
  listCompanyPaymentReadiness,
  type CompanyPaymentReadinessStatus,
} from "@/lib/services/vendor-payment-invitations"
import type {
  ComplianceRules,
  ComplianceStatusSummary,
  CostCode,
} from "@/lib/types"

/**
 * Open payables carry the work — they are the desk. Settled ones are history, kept
 * to a recent window so the Paid tab is useful without dragging years of rows along.
 */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

/**
 * Statuses that are no longer real obligations and never appear on the desk.
 * This used to list void/cancelled, none of which any code path could write —
 * the filter was inert. `rejected` is the state that actually exists.
 */
const CLOSED_STATUSES = ["rejected"]

/** Payment-run item statuses that mean the bill is spoken for by the rail. */
const ACTIVE_RUN_ITEM_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "processing",
  "partially_paid",
]

export interface PayableRunMembership {
  runId: string
  /** The run item's status — draft through partially_paid means in flight. */
  status: string
  /** The parent run's own status, which is what the viewer can act on. */
  runStatus: string
  /** True when the viewer prepared this run, and so can never approve it. */
  preparedByViewer: boolean
  totalDebitCents: number
}

export interface OrgPayablesDeskData {
  /** Every payable on the desk: open first (by due date), then recently settled. */
  bills: VendorBillSummary[]
  costCodes: CostCode[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  /** Company id → whether this builder can pay them electronically yet. */
  paymentReadinessByCompanyId: Record<string, CompanyPaymentReadinessStatus>
  /** Bill id → the active payment run that already claims it, when one does. */
  runMembershipByBillId: Record<string, PayableRunMembership>
  /** True when more open payables exist than were fetched. */
  truncated: boolean
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  query: { tab: "due" | "approval" | "approved" | "paid" | "all"; search: string }
  counts: Record<"due" | "approval" | "approved" | "paid" | "all", number>
  /** Forwarding address for emailed vendor invoices, when the org has a slug. */
  inboundBillsEmail: string | null
}

const DEFAULT_COMPLIANCE_RULES: ComplianceRules = {
  require_lien_waiver: false,
  block_payment_on_missing_docs: true,
  warn_subcontract_execution_on_missing_docs: true,
  block_subcontract_execution_on_missing_docs: false,
}

/**
 * The org-wide payables desk: every vendor bill anyone owes, in one list, with the
 * coding context the payables workspace needs to act on any of them without a
 * second round trip.
 */
export async function loadOrgPayablesDesk(
  projectIds: string[] | null = null,
  input: { tab?: string; search?: string; page?: number; pageSize?: number } = {},
): Promise<OrgPayablesDeskData> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["bill.read", "payment.read"], {
    supabase,
    orgId,
    userId,
  })

  const excludedProjectIds =
    projectIds === null
      ? []
      : await getReportingExcludedProjectIds(supabase, orgId)
  const tab = (["due", "approval", "approved", "paid", "all"] as const).includes(input.tab as any) ? input.tab as "due" | "approval" | "approved" | "paid" | "all" : "due"
  const search = String(input.search ?? "").trim().slice(0, 120)
  const searchFilter = search.replace(/[,%()]/g, " ").trim()
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(10, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)))
  const from = (page - 1) * pageSize
  const scoped = (count = false) => {
    const query = supabase
      .from("vendor_bills")
      .select(count ? "id" : vendorBillSelect, count ? { count: "exact", head: true } : { count: "exact" })
      .eq("org_id", orgId)
    return applyProjectIdScope(
      applyReportingExclusion(query, excludedProjectIds),
      projectIds,
    )
  }

  const applyTab = (query: any, key: typeof tab) => {
    if (key === "paid") return query.eq("status", "paid")
    if (key === "approval") return query.eq("status", "pending")
    if (key === "approved") return query.in("status", ["approved", "partial"])
    if (key === "due") return query.not("status", "in", `(${[...CLOSED_STATUSES, "paid"].join(",")})`)
    return query.not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
  }
  const applySearch = (query: any) => searchFilter
    ? query.or(`bill_number.ilike.%${searchFilter}%,qbo_vendor_name.ilike.%${searchFilter}%`)
    : query
  const pageQuery = applySearch(applyTab(scoped(), tab))
    .order(tab === "paid" ? "paid_at" : "due_date", { ascending: tab !== "paid", nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1)
  const [org, pageResult, dueCount, approvalCount, approvedCount, paidCount, allCount] = await Promise.all([
    supabase.from("orgs").select("slug").eq("id", orgId).maybeSingle(),
    pageQuery,
    applyTab(scoped(true), "due"),
    applyTab(scoped(true), "approval"),
    applyTab(scoped(true), "approved"),
    applyTab(scoped(true), "paid"),
    applyTab(scoped(true), "all"),
  ])

  if (pageResult.error) throw new Error(`Failed to load payables: ${pageResult.error.message}`)

  const rows = pageResult.data ?? []
  const bills = await hydrateVendorBills(supabase, orgId, rows)
  const companyIds = bills
    .map((bill) => bill.company_id)
    .filter(Boolean) as string[]

  // The desk stays readable when a supporting lookup fails — the payables themselves
  // are the page, everything else only decorates or codes them.
  const [
    costCodesResult,
    complianceRulesResult,
    complianceStatusResult,
    readinessResult,
    runItemsResult,
  ] = await Promise.allSettled([
    listCostCodes(orgId),
    getComplianceRules(orgId),
    getCompaniesComplianceStatus(companyIds, orgId),
    listCompanyPaymentReadiness(companyIds, orgId),
    supabase
      .from("payment_run_items")
      .select("bill_id, run_id, status")
      .eq("org_id", orgId)
      .in("status", ACTIVE_RUN_ITEM_STATUSES)
      .in(
        "bill_id",
        bills.map((bill) => bill.id),
      ),
  ])

  const paymentReadinessByCompanyId: Record<
    string,
    CompanyPaymentReadinessStatus
  > = {}
  if (readinessResult.status === "fulfilled") {
    for (const [companyId, readiness] of readinessResult.value) {
      paymentReadinessByCompanyId[companyId] = readiness.status
    }
  }

  const runMembershipByBillId: Record<string, PayableRunMembership> = {}
  if (runItemsResult.status === "fulfilled") {
    const items = runItemsResult.value.data ?? []
    const runIds = [
      ...new Set(items.map((item) => item.run_id).filter(Boolean)),
    ]
    const { data: runRows } =
      runIds.length > 0
        ? await supabase
            .from("payment_runs")
            .select("id,status,requested_by,total_debit_cents")
            .eq("org_id", orgId)
            .in("id", runIds)
        : { data: [] }
    const runById = new Map((runRows ?? []).map((run) => [run.id, run]))
    for (const item of items) {
      if (!item.bill_id || !item.run_id) continue
      const run = runById.get(item.run_id)
      runMembershipByBillId[item.bill_id] = {
        runId: item.run_id,
        status: item.status,
        runStatus: run?.status ?? item.status,
        preparedByViewer: run?.requested_by === userId,
        totalDebitCents: Number(run?.total_debit_cents ?? 0),
      }
    }
  }

  return {
    bills,
    costCodes:
      costCodesResult.status === "fulfilled" ? costCodesResult.value : [],
    complianceRules:
      complianceRulesResult.status === "fulfilled"
        ? complianceRulesResult.value
        : DEFAULT_COMPLIANCE_RULES,
    complianceStatusByCompanyId:
      complianceStatusResult.status === "fulfilled"
        ? complianceStatusResult.value
        : {},
    paymentReadinessByCompanyId,
    runMembershipByBillId,
    truncated: (pageResult.count ?? 0) > from + pageSize,
    pagination: { page, pageSize, total: pageResult.count ?? 0, pageCount: Math.max(1, Math.ceil((pageResult.count ?? 0) / pageSize)) },
    query: { tab, search },
    counts: { due: dueCount.count ?? 0, approval: approvalCount.count ?? 0, approved: approvedCount.count ?? 0, paid: paidCount.count ?? 0, all: allCount.count ?? 0 },
    inboundBillsEmail: org.data?.slug
      ? orgBillsInboundAddress(org.data.slug as string)
      : null,
  }
}
