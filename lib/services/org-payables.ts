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
const OPEN_FETCH_LIMIT = 500
const SETTLED_FETCH_LIMIT = 150

/** Statuses that are no longer real obligations and never appear on the desk. */
const CLOSED_STATUSES = ["void", "voided", "cancelled", "canceled"]

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
  /** Bill id → the scanned invoice to open from the row, when one exists. */
  documentFileIdByBillId: Record<string, string>
  /** Company id → whether this builder can pay them electronically yet. */
  paymentReadinessByCompanyId: Record<string, CompanyPaymentReadinessStatus>
  /** Bill id → the active payment run that already claims it, when one does. */
  runMembershipByBillId: Record<string, PayableRunMembership>
  /** True when more open payables exist than were fetched. */
  truncated: boolean
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
  const scoped = () => {
    const query = supabase
      .from("vendor_bills")
      .select(vendorBillSelect)
      .eq("org_id", orgId)
    return applyProjectIdScope(
      applyReportingExclusion(query, excludedProjectIds),
      projectIds,
    )
  }

  const [org, openResult, settledResult] = await Promise.all([
    supabase.from("orgs").select("slug").eq("id", orgId).maybeSingle(),
    scoped()
      .not("status", "in", `(${[...CLOSED_STATUSES, "paid"].join(",")})`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(OPEN_FETCH_LIMIT),
    scoped()
      .eq("status", "paid")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(SETTLED_FETCH_LIMIT),
  ])

  if (openResult.error)
    throw new Error(`Failed to load payables: ${openResult.error.message}`)
  if (settledResult.error)
    throw new Error(
      `Failed to load paid payables: ${settledResult.error.message}`,
    )

  const rows = [...(openResult.data ?? []), ...(settledResult.data ?? [])]
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
    attachmentsResult,
    runItemsResult,
  ] = await Promise.allSettled([
    listCostCodes(orgId),
    getComplianceRules(orgId),
    getCompaniesComplianceStatus(companyIds, orgId),
    listCompanyPaymentReadiness(companyIds, orgId),
    supabase
      .from("file_links")
      .select("entity_id, file_id")
      .eq("org_id", orgId)
      .eq("entity_type", "vendor_bill")
      .in(
        "entity_id",
        bills.map((bill) => bill.id),
      ),
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

  // A payable's scanned invoice is either attached to it or stamped on the row
  // itself, depending on how it arrived (email ingest, upload, accounting import).
  const documentFileIdByBillId: Record<string, string> = {}
  for (const bill of bills) {
    if (bill.file_id) documentFileIdByBillId[bill.id] = bill.file_id
  }
  if (attachmentsResult.status === "fulfilled") {
    for (const link of attachmentsResult.value.data ?? []) {
      if (link.file_id) documentFileIdByBillId[link.entity_id] = link.file_id
    }
  }

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
    documentFileIdByBillId,
    paymentReadinessByCompanyId,
    runMembershipByBillId,
    truncated: (openResult.data?.length ?? 0) >= OPEN_FETCH_LIMIT,
    inboundBillsEmail: org.data?.slug
      ? orgBillsInboundAddress(org.data.slug as string)
      : null,
  }
}
