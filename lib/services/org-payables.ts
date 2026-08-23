import { getCodingAutomationStats, type CodingAutomationStats } from "@/lib/services/books/coding-rules"
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
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { requesterMayApprovePaymentRun } from "@/lib/payments/payment-domain"
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
export const ACTIVE_RUN_ITEM_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "processing",
  "partially_paid",
]

/**
 * How many open payables the money summary reads. Counts and totals for the
 * working tabs are computed from real outstanding balances — retainage and
 * partial payments make that an expression no aggregate query can sum — so the
 * scan is bounded and says so when it truncates. Settled history is counted, not
 * scanned, because it grows without limit.
 */
const SUMMARY_SCAN_LIMIT = 2000
/** Active run items across the org; bounded by how many runs can be in flight. */
const ACTIVE_RUN_ITEM_LIMIT = 1000
/** Matches nothing — a stand-in when an `in` list would otherwise be empty. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const DAY_MS = 86_400_000

/**
 * The payables pipeline, in the order money travels it. Every payable sits on
 * exactly one working tab, which is what makes the totals beside them addable.
 */
export const PAYABLE_TABS = [
  "drafts",
  "approval",
  "ready",
  "inflight",
  "paid",
  "all",
] as const
export type PayableTabKey = (typeof PAYABLE_TABS)[number]

export interface PayableTabSummary {
  count: number
  /** Outstanding balance, not billed total — what is still owed. */
  amountCents: number
}

export interface PayableRunMembership {
  runId: string
  /** The run item's status — draft through partially_paid means in flight. */
  status: string
  /** The parent run's own status, which is what the viewer can act on. */
  runStatus: string
  /** True when the viewer prepared this run, and so can never approve it. */
  preparedByViewer: boolean
  /** Frozen exception for an explicitly owner-operated organization. */
  requesterMayApprove: boolean
  totalDebitCents: number
  /** Release date when the preparer scheduled one, else null for "on approval". */
  scheduledFor: string | null
}

export interface PayablePaymentDecorations {
  paymentReadinessByCompanyId: Record<string, CompanyPaymentReadinessStatus>
  runMembershipByBillId: Record<string, PayableRunMembership>
}

/**
 * Arc Pay facts for any payable collection, regardless of which desk loaded it.
 *
 * The org desk needs these facts to build its pipeline; the project desk needs
 * the same facts so opening a bill there does not fall back to the legacy
 * "record an external payment" experience while an Arc payment is already
 * ready, scheduled, or awaiting approval.
 */
export async function loadPayablePaymentDecorations(
  bills: Array<{ id: string; company_id?: string | null }>,
  orgId?: string,
): Promise<PayablePaymentDecorations> {
  if (bills.length === 0) {
    return { paymentReadinessByCompanyId: {}, runMembershipByBillId: {} }
  }

  const context = await requireOrgContext(orgId)
  const supabase = context.supabase
  const billIds = [...new Set(bills.map((bill) => bill.id).filter(Boolean))]
  const companyIds = [
    ...new Set(
      bills
        .map((bill) => bill.company_id)
        .filter((companyId): companyId is string => Boolean(companyId)),
    ),
  ]

  const [readiness, runItemsResult] = await Promise.all([
    listCompanyPaymentReadiness(companyIds, context.orgId),
    supabase
      .from("payment_run_items")
      .select("bill_id,run_id,status")
      .eq("org_id", context.orgId)
      .in("bill_id", billIds)
      .in("status", ACTIVE_RUN_ITEM_STATUSES)
      .limit(ACTIVE_RUN_ITEM_LIMIT),
  ])
  if (runItemsResult.error) {
    throw new Error(`Unable to load payable payment runs: ${runItemsResult.error.message}`)
  }

  const runItems = (runItemsResult.data ?? []).filter(
    (item) => item.bill_id && item.run_id,
  )
  const runIds = [...new Set(runItems.map((item) => item.run_id as string))]
  const runsResult = runIds.length
    ? await supabase
        .from("payment_runs")
        .select("id,status,requested_by,total_debit_cents,scheduled_for,control_snapshot")
        .eq("org_id", context.orgId)
        .in("id", runIds)
    : { data: [], error: null }
  if (runsResult.error) {
    throw new Error(`Unable to load payable payment status: ${runsResult.error.message}`)
  }

  const paymentReadinessByCompanyId: Record<
    string,
    CompanyPaymentReadinessStatus
  > = {}
  for (const [companyId, companyReadiness] of readiness) {
    paymentReadinessByCompanyId[companyId] = companyReadiness.status
  }

  const runById = new Map(
    ((runsResult.data ?? []) as Array<Record<string, any>>).map((run) => [
      run.id as string,
      run,
    ]),
  )
  const runMembershipByBillId: Record<string, PayableRunMembership> = {}
  for (const item of runItems) {
    const run = runById.get(item.run_id as string)
    runMembershipByBillId[item.bill_id as string] = {
      runId: item.run_id as string,
      status: item.status,
      runStatus: (run?.status as string) ?? item.status,
      preparedByViewer: run?.requested_by === context.userId,
      requesterMayApprove: requesterMayApprovePaymentRun(run?.control_snapshot),
      totalDebitCents: Number(run?.total_debit_cents ?? 0),
      scheduledFor: (run?.scheduled_for as string | null) ?? null,
    }
  }

  return { paymentReadinessByCompanyId, runMembershipByBillId }
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
  query: { tab: PayableTabKey; search: string }
  tabs: Record<PayableTabKey, PayableTabSummary>
  /** True when open payables outran the summary scan, so the tab totals understate. */
  summaryTruncated: boolean
  /** Forwarding address for emailed vendor invoices, when the org has a slug. */
  inboundBillsEmail: string | null
  /** How much coding the org still does by hand. Null when the read failed. */
  codingAutomation: CodingAutomationStats | null
}

const DEFAULT_COMPLIANCE_RULES: ComplianceRules = {
  require_lien_waiver: false,
  block_payment_on_missing_docs: true,
  warn_subcontract_execution_on_missing_docs: true,
  block_subcontract_execution_on_missing_docs: false,
}

/** The narrow row the money summary reads — no joins, no hydration. */
interface SummaryRow {
  id: string
  status: string | null
  total_cents: number | null
  paid_cents: number | null
  retainage_cents: number | null
  metadata: Record<string, unknown> | null
}

const SUMMARY_SELECT =
  "id, status, total_cents, paid_cents, retainage_cents, metadata"

function emptySummary(): PayableTabSummary {
  return { count: 0, amountCents: 0 }
}

/**
 * The org-wide payables desk: every vendor bill anyone owes, in one list, with the
 * coding context the payables workspace needs to act on any of them without a
 * second round trip.
 */
export async function loadOrgPayablesDesk(
  projectIds: string[] | null = null,
  input: {
    tab?: string
    search?: string
    page?: number
    pageSize?: number
  } = {},
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
  const tab: PayableTabKey = PAYABLE_TABS.includes(input.tab as PayableTabKey)
    ? (input.tab as PayableTabKey)
    : "approval"
  const search = String(input.search ?? "").trim().slice(0, 120)
  const searchFilter = search.replace(/[,%()]/g, " ").trim()
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(10, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)))
  const from = (page - 1) * pageSize

  const scoped = (select: string, count = false) => {
    const query = supabase
      .from("vendor_bills")
      .select(select, count ? { count: "exact", head: true } : { count: "exact" })
      .eq("org_id", orgId)
    return applyProjectIdScope(
      applyReportingExclusion(query, excludedProjectIds),
      projectIds,
    )
  }

  /**
   * Drafts are deliberately excluded from every working tab — a quick capture is
   * not an obligation yet — and vendor credits from all of them, because they are
   * money coming back and would invert the totals beside each tab name.
   */
  const workingScope = (query: any) =>
    query
      .or("metadata->>creation_state.is.null,metadata->>creation_state.neq.draft")
      .or("metadata->>source.is.null,metadata->>source.neq.vendor_credit")

  /**
   * Every read that does not care which bills a run already claims goes out now,
   * so it overlaps the one that does. A tab switch re-runs this whole function,
   * and a round trip spent waiting is the difference between a filter and a page
   * load. `.then` is what actually dispatches a Supabase builder.
   */
  const orgPromise = supabase.from("orgs").select("slug").eq("id", orgId).maybeSingle().then((result) => result)
  const summaryPromise = scoped(SUMMARY_SELECT)
    .not("status", "in", `(${[...CLOSED_STATUSES, "paid"].join(",")})`)
    // Ordered so that if the scan ever truncates, what it covers is the most
    // urgent 2,000 rather than an arbitrary 2,000.
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(SUMMARY_SCAN_LIMIT)
    .then((result: unknown) => result)
  const paidCountPromise = workingScope(scoped("id", true)).eq("status", "paid").then((result: unknown) => result)
  const allCountPromise = scoped("id", true)
    .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
    .then((result: unknown) => result)

  // Which bills the rail already claims: the difference between "ready to pay"
  // and "in flight", so both of those tabs have to wait for it.
  const { data: runItemRows } = await supabase
    .from("payment_run_items")
    .select("bill_id, run_id, status")
    .eq("org_id", orgId)
    .in("status", ACTIVE_RUN_ITEM_STATUSES)
    .limit(ACTIVE_RUN_ITEM_LIMIT)
  const runItems = (runItemRows ?? []).filter((item) => item.bill_id && item.run_id)
  const inRunBillIds = new Set(runItems.map((item) => item.bill_id as string))
  const inRunList = Array.from(inRunBillIds)

  const applyTab = (query: any, key: PayableTabKey) => {
    if (key === "drafts") return query.eq("metadata->>creation_state", "draft")
    if (key === "paid") return workingScope(query).eq("status", "paid")
    if (key === "inflight")
      return workingScope(query).in("id", inRunList.length > 0 ? inRunList : [NIL_UUID])
    if (key === "approval") return workingScope(query).eq("status", "pending")
    if (key === "ready") {
      const ready = workingScope(query).in("status", ["approved", "partial"])
      return inRunList.length > 0
        ? ready.not("id", "in", `(${inRunList.join(",")})`)
        : ready
    }
    return query.not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
  }

  const applySearch = (query: any) => searchFilter
    ? query.or(`bill_number.ilike.%${searchFilter}%,qbo_vendor_name.ilike.%${searchFilter}%`)
    : query

  const pageQuery = applySearch(applyTab(scoped(vendorBillSelect), tab))
    .order(tab === "paid" ? "paid_at" : "due_date", { ascending: tab !== "paid", nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1)

  const [org, pageResult, summaryResult, paidCount, allCount] = (await Promise.all([
    orgPromise,
    pageQuery,
    summaryPromise,
    paidCountPromise,
    allCountPromise,
  ])) as [
    { data: { slug?: string } | null },
    { data: unknown[] | null; error: { message: string } | null; count: number | null },
    { data: SummaryRow[] | null; count: number | null },
    { count: number | null },
    { count: number | null },
  ]

  if (pageResult.error) throw new Error(`Failed to load payables: ${pageResult.error.message}`)

  const tabs: Record<PayableTabKey, PayableTabSummary> = {
    drafts: emptySummary(),
    approval: emptySummary(),
    ready: emptySummary(),
    inflight: emptySummary(),
    paid: { count: paidCount.count ?? 0, amountCents: 0 },
    all: { count: allCount.count ?? 0, amountCents: 0 },
  }
  for (const row of (summaryResult.data ?? []) as unknown as SummaryRow[]) {
    const metadata = row.metadata ?? {}
    const isDraft = metadata.creation_state === "draft"
    const isCredit = metadata.source === "vendor_credit"
    const outstanding = payableOutstandingCents({
      payable_type: isCredit ? "vendor_credit" : "bill",
      total_cents: row.total_cents,
      paid_cents: Number(row.paid_cents ?? 0),
      retainage_cents: row.retainage_cents,
    })

    if (isDraft) {
      tabs.drafts.count += 1
      tabs.drafts.amountCents += outstanding
      continue
    }
    if (isCredit) continue

    const bucket = inRunBillIds.has(row.id)
      ? tabs.inflight
      : row.status === "pending"
        ? tabs.approval
        : row.status === "approved" || row.status === "partial"
          ? tabs.ready
          : null
    if (!bucket) continue
    bucket.count += 1
    bucket.amountCents += outstanding
  }

  const rows = pageResult.data ?? []
  const bills = await hydrateVendorBills(supabase, orgId, rows)
  const billIds = new Set(bills.map((bill) => bill.id))
  const companyIds = bills
    .map((bill) => bill.company_id)
    .filter(Boolean) as string[]

  const pageRunItems = runItems.filter((item) => billIds.has(item.bill_id as string))
  const pageRunIds = [...new Set(pageRunItems.map((item) => item.run_id as string))]

  // The desk stays readable when a supporting lookup fails — the payables themselves
  // are the page, everything else only decorates or codes them.
  const [
    costCodesResult,
    complianceRulesResult,
    complianceStatusResult,
    readinessResult,
    runsResult,
    codingAutomationResult,
  ] = await Promise.allSettled([
    listCostCodes(orgId),
    getComplianceRules(orgId),
    // Scoped to the jobs these payables are on: the release gate reads a
    // vendor against the project overlay, so a chip resolved without it can
    // read green on a bill the gate will stop.
    getCompaniesComplianceStatus(companyIds, orgId, {
      projectIds: [...new Set(bills.map((bill) => bill.project_id).filter(Boolean))],
    }),
    listCompanyPaymentReadiness(companyIds, orgId),
    pageRunIds.length > 0
      ? supabase
          .from("payment_runs")
          .select("id,status,requested_by,total_debit_cents,scheduled_for,control_snapshot")
          .eq("org_id", orgId)
          .in("id", pageRunIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    getCodingAutomationStats(orgId),
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
  if (runsResult.status === "fulfilled") {
    const runById = new Map(
      ((runsResult.value.data ?? []) as Array<Record<string, any>>).map((run) => [
        run.id as string,
        run,
      ]),
    )
    for (const item of pageRunItems) {
      const run = runById.get(item.run_id as string)
      runMembershipByBillId[item.bill_id as string] = {
        runId: item.run_id as string,
        status: item.status,
        runStatus: (run?.status as string) ?? item.status,
        preparedByViewer: run?.requested_by === userId,
        requesterMayApprove: requesterMayApprovePaymentRun(run?.control_snapshot),
        totalDebitCents: Number(run?.total_debit_cents ?? 0),
        scheduledFor: (run?.scheduled_for as string | null) ?? null,
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
    tabs,
    // The scan's own exact count knows how many open payables there really are,
    // so truncation is a fact rather than an inference from a full page.
    summaryTruncated: (summaryResult.count ?? 0) > SUMMARY_SCAN_LIMIT,
    inboundBillsEmail: org.data?.slug
      ? orgBillsInboundAddress(org.data.slug as string)
      : null,
    codingAutomation:
      codingAutomationResult.status === "fulfilled" ? codingAutomationResult.value : null,
  }
}
