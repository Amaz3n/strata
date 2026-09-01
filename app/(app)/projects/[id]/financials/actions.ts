"use server"

import { revalidatePath } from "next/cache"

import { getBudgetWithActuals, listBudgetBucketChangeOrders, listProjectBudgetLines, listVarianceAlertsForProject } from "@/lib/services/budgets"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listProjectCommitments } from "@/lib/services/commitments"
import { getInvoiceQueueCounts, getProjectInvoiceArSummary, listInvoicePage } from "@/lib/services/invoices"
import { listBillableContacts } from "@/lib/services/contacts"
import { getVendorBillForProject, listVendorBillsPageForProject } from "@/lib/services/vendor-bills"
import { getProjectBuyoutStatus } from "@/lib/services/bids"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import {
  createManualBillableAdjustment,
  generateInvoiceFromCosts,
} from "@/lib/services/cost-plus"
import { generateInvoiceFromCostsInputSchema, manualBillableAdjustmentInputSchema } from "@/lib/validation/cost-plus"
import {
  closeProjectBillingPeriod,
  createProjectBillingPeriod,
  type CloseBillingPeriodInput,
  type CreateBillingPeriodInput,
} from "@/lib/services/billing-periods"
import {
  generateInvoiceBackupPackage,
  listProjectOwnerBillingPackageSummaries,
  shareInvoiceBackupPackage,
  summarizeOwnerBillingPackage,
} from "@/lib/services/owner-billing-packages"
import {
  createProjectFeeInvoice,
  getProjectFeeBillingSummary,
  updateProjectFeeProgress,
  type CreateFeeInvoiceInput,
  type UpdateFeeProgressInput,
} from "@/lib/services/fee-billing"
import { recordGmpContingencyDrawdown } from "@/lib/services/gmp-control"
import {
  createTmTicket,
  createTmTicketSignatureLink,
  generateInvoiceFromTmTicket,
  submitTmTicket,
  voidTmTicket,
} from "@/lib/services/tm-tickets"
import {
  getProjectFinancialSetupStatusForProject,
  saveProjectFinancialSetup,
  type FinancialSetupInput,
} from "@/lib/services/project-financial-setup"
import {
  importSovFromBudget,
  importSovFromEstimate,
  upsertPrimeSovLines,
} from "@/lib/services/prime-sov"
import {
  createPayApplication,
  deletePayApplication,
  getPayApplication,
  listPayApplications,
  markPayApplicationApproved,
  releasePrimeRetainage,
  submitPayApplication,
  updatePayApplicationLines,
  voidPayApplication,
} from "@/lib/services/pay-applications"
import { generateSovPayApplicationPdf } from "@/lib/services/reports/pay-application-g702"
import type {
  PayApplicationLineEntry,
  PrimeSovLineInput,
  RetainageReleaseInput,
} from "@/lib/validation/pay-applications"
import { requireOrgContext } from "@/lib/services/context"
import { loadPayablePaymentDecorations } from "@/lib/services/org-payables"
import { listBudgetTransfers } from "@/lib/services/budget-transfers"
import { generatePurchaseOrders, listGenerationRuns, listPoExceptions } from "@/lib/services/po-generation"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

function resultError(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null
  return `${label}: ${messageForError(result.reason)}`
}

/**
 * Fetch all data needed for the Budget tab
 * - Budget data with actuals
 * - Cost codes for line item assignment
 * - Variance alerts
 * - Commitments (merged into budget tab)
 *
 * Vendor companies are deliberately NOT loaded here — the commitment dialogs
 * lazy-load them on open (`listBudgetCompaniesAction`) so a large org
 * directory never rides along with every budget page view.
 */
export async function fetchBudgetTabDataAction(projectId: string) {
      const [
        budgetDataResult,
        costCodesResult,
        varianceAlertsResult,
        commitmentsResult,
        buyoutStatusResult,
        transfersResult,
      ] = await Promise.allSettled([
        getBudgetWithActuals(projectId),
        listCostCodes(),
        listVarianceAlertsForProject(projectId),
        listProjectCommitments(projectId),
        getProjectBuyoutStatus(projectId),
        listBudgetTransfers(projectId),
      ])

      const budgetData = budgetDataResult.status === "fulfilled" ? budgetDataResult.value : null
      const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
      const varianceAlerts = varianceAlertsResult.status === "fulfilled" ? varianceAlertsResult.value : []
      const commitments = commitmentsResult.status === "fulfilled" ? commitmentsResult.value : []
      const errors = [
        resultError("Budget", budgetDataResult),
        resultError("Cost codes", costCodesResult),
        resultError("Variance alerts", varianceAlertsResult),
        resultError("Commitments", commitmentsResult),
        resultError("Buyout status", buyoutStatusResult),
        resultError("Budget transfers", transfersResult),
      ].filter(Boolean) as string[]
      const budgetBucketCompanies = await buildBudgetBucketCompanies(commitments)

      return {
        budgetData,
        costCodes,
        varianceAlerts,
        commitments,
        buyoutStatus: buyoutStatusResult.status === "fulfilled" ? buyoutStatusResult.value : null,
        budgetBucketCompanies,
        budgetTransfers: transfersResult.status === "fulfilled" ? transfersResult.value : [],
        errors,
      }
}

async function buildBudgetBucketCompanies(commitments: Awaited<ReturnType<typeof listProjectCommitments>>) {
  if (commitments.length === 0) return {}

  const { supabase, orgId } = await requireOrgContext()
  const companyNamesByBucket = new Map<string, Set<string>>()
  const commitmentById = new Map(commitments.map((commitment) => [commitment.id, commitment]))
  const { data: lines } = await supabase
    .from("commitment_lines")
    .select("commitment_id, cost_code_id, budget_line_id")
    .eq("org_id", orgId)
    .in("commitment_id", commitments.map((commitment) => commitment.id))

  for (const line of lines ?? []) {
    const commitment = commitmentById.get(line.commitment_id as string)
    if (!commitment) continue
    const companyName = commitment.company_name?.trim()
    if (!companyName) continue

    const key = line.budget_line_id ?? line.cost_code_id ?? "uncoded"
    const names = companyNamesByBucket.get(key) ?? new Set<string>()
    names.add(companyName)
    companyNamesByBucket.set(key, names)
  }

  return Object.fromEntries(
    Array.from(companyNamesByBucket.entries()).map(([key, names]) => [
      key,
      Array.from(names).sort((a, b) => a.localeCompare(b)),
    ]),
  )
}

/**
 * Fetch all data needed for the Receivables tab
 * - Invoices for the project
 * - Contacts for invoice recipients
 * - Cost codes for invoice line items
 */
export async function fetchBillingTabDataAction(projectId: string) {
      const [invoicesResult, contactsResult, costCodesResult, ownerPackagesResult, feeSummaryResult, arSummaryResult, queueCountsResult] = await Promise.allSettled([
        // First page only; the queue lazy-loads the rest via "Load more". Filtering,
        // sorting and counting happen in the database from here on.
        listInvoicePage({ projectId, limit: 100, sort: "activity", sortDirection: "desc" }),
        listBillableContacts(),
        listCostCodes(),
        listProjectOwnerBillingPackageSummaries(projectId),
        // Always fetched: it resolves the billing model itself, so the Fee tab can't
        // desync from a separately-fetched setup status.
        getProjectFeeBillingSummary(projectId),
        // Whole-book aging so the AR strip stays correct beyond the first invoice page.
        getProjectInvoiceArSummary({ projectId }),
        getInvoiceQueueCounts({ projectId }),
      ])

      const feeSummary = feeSummaryResult.status === "fulfilled" ? feeSummaryResult.value : null
      const invoicePage = invoicesResult.status === "fulfilled" ? invoicesResult.value : null
      return {
        invoices: invoicePage?.invoices ?? [],
        invoiceTotalCount: invoicePage?.totalCount ?? 0,
        queueCounts:
          queueCountsResult.status === "fulfilled"
            ? queueCountsResult.value
            : { all: 0, preparing: 0, awaiting_approval: 0, ready: 0, open: 0, overdue: 0, exceptions: 0, paid: 0, void: 0 },
        contacts: contactsResult.status === "fulfilled" ? contactsResult.value : [],
        costCodes: costCodesResult.status === "fulfilled" ? costCodesResult.value : [],
        ownerBillingPackages: ownerPackagesResult.status === "fulfilled" ? ownerPackagesResult.value : [],
        feeSummary,
        arSummary: arSummaryResult.status === "fulfilled" ? arSummaryResult.value : null,
        errors: [
          resultError("Invoices", invoicesResult),
          resultError("Contacts", contactsResult),
          resultError("Cost codes", costCodesResult),
          resultError("Owner billing packages", ownerPackagesResult),
          resultError("Fee billing", feeSummaryResult),
          // Named on purpose. When the whole-book aggregate failed, the page used
          // to quietly show nothing where the money totals go, which reads as
          // "there is no receivable here" rather than "we could not add it up".
          resultError("Receivables totals", arSummaryResult),
          resultError("Queue counts", queueCountsResult),
        ].filter(Boolean) as string[],
      }
}


/**
 * Fetch all data needed for the Payables tab
 * - Vendor bills for the project
 * - Compliance rules for payment blocking
 */
export async function fetchPayablesTabDataAction(projectId: string, query: { page?: number; pageSize?: number; queue?: string; due?: string; search?: string; billId?: string } = {}) {
      const [vendorBillsResult, selectedBillResult, complianceRulesResult, costCodesResult, budgetLinesResult] = await Promise.allSettled([
        listVendorBillsPageForProject(projectId, query),
        query.billId ? getVendorBillForProject(projectId, query.billId) : Promise.resolve(null),
        getComplianceRules(),
        listCostCodes(),
        listProjectBudgetLines(projectId),
      ])

      const vendorBillsPage = vendorBillsResult.status === "fulfilled" ? vendorBillsResult.value : {
        items: [], page: 1, pageSize: 50, total: 0, pageCount: 1,
        query: { queue: "approval" as const, due: "any" as const, search: "" },
        tabs: {
          drafts: { count: 0, amountCents: 0 }, approval: { count: 0, amountCents: 0 },
          ready: { count: 0, amountCents: 0 }, inflight: { count: 0, amountCents: 0 },
          paid: { count: 0, amountCents: 0 }, all: { count: 0, amountCents: 0 },
        },
        summaryTruncated: false,
      }
      const vendorBills = vendorBillsPage.items
      const selectedBill = selectedBillResult.status === "fulfilled" ? selectedBillResult.value : null
      const decorationBills = selectedBill && !vendorBills.some((bill) => bill.id === selectedBill.id)
        ? [...vendorBills, selectedBill]
        : vendorBills
      const complianceRules =
        complianceRulesResult.status === "fulfilled"
          ? complianceRulesResult.value
          : {
              require_lien_waiver: false,
              block_payment_on_missing_docs: true,
              warn_subcontract_execution_on_missing_docs: true,
              block_subcontract_execution_on_missing_docs: false,
            }
      const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
      const budgetLines = budgetLinesResult.status === "fulfilled" ? budgetLinesResult.value : []
      const companyIds = Array.from(new Set(decorationBills.map((b) => b.company_id).filter(Boolean))) as string[]
      // This tab is one job, so the vendors are read against that job's
      // overlay — the same scope the release gate uses.
      const complianceStatusResult = await Promise.allSettled([
        getCompaniesComplianceStatus(companyIds, undefined, { projectIds: [projectId] }),
      ])
      const complianceStatusByCompanyId =
        complianceStatusResult[0].status === "fulfilled" ? complianceStatusResult[0].value : {}
      const paymentDecorations = await loadPayablePaymentDecorations(decorationBills).catch(() => ({
        paymentReadinessByCompanyId: {},
        runMembershipByBillId: {},
      }))

      return {
        vendorBills,
        selectedBill,
        vendorBillsPage,
        complianceRules,
        complianceStatusByCompanyId,
        paymentReadinessByCompanyId: paymentDecorations.paymentReadinessByCompanyId,
        runMembershipByBillId: paymentDecorations.runMembershipByBillId,
        costCodes,
        budgetLines,
        errors: [
          resultError("Vendor bills", vendorBillsResult),
          resultError("Selected payable", selectedBillResult),
          resultError("Compliance rules", complianceRulesResult),
          resultError("Cost codes", costCodesResult),
          resultError("Compliance status", complianceStatusResult[0]),
        ].filter(Boolean) as string[],
      }
}

export async function generateInvoiceFromCostsAction(input: unknown) {
  return run(async () => {
      const parsed = generateInvoiceFromCostsInputSchema.parse(input)
      const result = await generateInvoiceFromCosts(parsed)
      if (!parsed.dryRun) {
        revalidatePath(`/projects/${parsed.projectId}`)
        revalidatePath(`/projects/${parsed.projectId}/financials`)
        revalidatePath(`/projects/${parsed.projectId}/financials/cost-inbox`)
        revalidatePath(`/projects/${parsed.projectId}/financials/billing`)
      }
      return result
  })
}

export async function createManualBillableAdjustmentAction(input: unknown) {
  return run(async () => {
      const parsed = manualBillableAdjustmentInputSchema.parse(input)
      const adjustment = await createManualBillableAdjustment(parsed)
      revalidatePath(`/projects/${parsed.projectId}`)
      revalidatePath(`/projects/${parsed.projectId}/financials`)
      revalidatePath(`/projects/${parsed.projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${parsed.projectId}/financials/billing`)
      revalidatePath(`/projects/${parsed.projectId}/financials/budget`)
      return adjustment
  })
}

export async function saveProjectFinancialSetupAction(input: FinancialSetupInput) {
  return run(async () => {
      const result = await saveProjectFinancialSetup(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/budget`)
      revalidatePath(`/projects/${input.projectId}/financials/payables`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return result
  })
}

export async function createTmTicketAction(input: {
  projectId: string
  workDate: string
  billableCostIds?: string[]
  notes?: string | null
}) {
  return run(async () => {
      const ticket = await createTmTicket({
        projectId: input.projectId,
        workDate: new Date(`${input.workDate}T00:00:00`),
        billableCostIds: input.billableCostIds,
        notes: input.notes ?? null,
      })
      revalidatePath(`/projects/${input.projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${input.projectId}/financials/tm-tickets`)
      return ticket
  })
}

export async function submitTmTicketAction(projectId: string, ticketId: string) {
  return run(async () => {
      const ticket = await submitTmTicket(ticketId)
      revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
      return ticket
  })
}

export async function createTmTicketSignatureLinkAction(projectId: string, ticketId: string) {
  return run(async () => {
      const link = await createTmTicketSignatureLink(ticketId)
      revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
      return link
  })
}

export async function generateInvoiceFromTmTicketAction(projectId: string, ticketId: string) {
  return run(async () => {
      const result = await generateInvoiceFromTmTicket(ticketId)
      revalidatePath(`/projects/${projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return result
  })
}

export async function voidTmTicketAction(projectId: string, ticketId: string) {
  return run(async () => {
      const ticket = await voidTmTicket(ticketId)
      revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
      return ticket
  })
}

export async function createProjectBillingPeriodAction(input: CreateBillingPeriodInput) {
  return run(async () => {
      const period = await createProjectBillingPeriod(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return period
  })
}

export async function closeProjectBillingPeriodAction(input: CloseBillingPeriodInput) {
  return run(async () => {
      const period = await closeProjectBillingPeriod(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return period
  })
}

export async function generateOwnerBillingPackageAction(input: { projectId: string; invoiceId: string; includeGcCompliance?: boolean }) {
  return run(async () => {
      const pkg = await generateInvoiceBackupPackage(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/cost-inbox`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return summarizeOwnerBillingPackage(pkg)
  })
}

export async function shareOwnerBillingPackageAction(input: { projectId: string; packageId: string }) {
  return run(async () => {
      const pkg = await shareInvoiceBackupPackage(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return summarizeOwnerBillingPackage(pkg)
  })
}

export async function updateProjectFeeProgressAction(input: UpdateFeeProgressInput) {
  return run(async () => {
      const summary = await updateProjectFeeProgress(input)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/budget`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return summary
  })
}

export async function createProjectFeeInvoiceAction(input: CreateFeeInvoiceInput) {
  return run(async () => {
      const invoice = await createProjectFeeInvoice(input)
      const feeSummary = await getProjectFeeBillingSummary(input.projectId)
      revalidatePath(`/projects/${input.projectId}`)
      revalidatePath(`/projects/${input.projectId}/financials`)
      revalidatePath(`/projects/${input.projectId}/financials/budget`)
      revalidatePath(`/projects/${input.projectId}/financials/billing`)
      return { invoice, feeSummary }
  })
}

export async function savePrimeSovLinesAction(projectId: string, input: { lines: PrimeSovLineInput[] }) {
  return run(async () => {
      const state = await upsertPrimeSovLines(projectId, input)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return state
  })
}

export async function importPrimeSovFromBudgetAction(projectId: string) {
  return run(async () => {
      const state = await importSovFromBudget(projectId)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return state
  })
}

export async function importPrimeSovFromEstimateAction(projectId: string) {
  return run(async () => {
      const state = await importSovFromEstimate(projectId)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return state
  })
}

export async function createPayApplicationAction(
  projectId: string,
  input: { period_start?: string | null; period_end: string },
) {
  return run(async () => {
      const detail = await createPayApplication(projectId, input)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return detail
  })
}

export async function fetchPayApplicationAction(payApplicationId: string) {
  return run(() => getPayApplication(payApplicationId))
}

export async function updatePayApplicationLinesAction(
  projectId: string,
  payApplicationId: string,
  input: { entries: PayApplicationLineEntry[]; allow_overbilling?: boolean },
) {
  return run(async () => {
      const detail = await updatePayApplicationLines(payApplicationId, input)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return detail
  })
}

export async function submitPayApplicationAction(projectId: string, payApplicationId: string) {
  return run(async () => {
      const detail = await submitPayApplication(payApplicationId)
      const payApplications = await listPayApplications(projectId)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return { detail, payApplications }
  })
}

export async function voidPayApplicationAction(projectId: string, payApplicationId: string) {
  return run(async () => {
      const detail = await voidPayApplication(payApplicationId)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return detail
  })
}

export async function deletePayApplicationAction(projectId: string, payApplicationId: string) {
  return run(async () => {
      const result = await deletePayApplication(payApplicationId)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return result
  })
}

export async function markPayApplicationApprovedAction(projectId: string, payApplicationId: string) {
  return run(async () => {
      const detail = await markPayApplicationApproved(payApplicationId)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return detail
  })
}

export async function generatePayApplicationPdfAction(projectId: string, payApplicationId: string) {
  return run(async () => {
      const { fileName, pdf } = await generateSovPayApplicationPdf({ projectId, payApplicationId })
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return { fileName, pdfBase64: pdf.toString("base64") }
  })
}

export async function generatePayApplicationPackageAction(
  projectId: string,
  payApplicationId: string,
  input: { includeGcCompliance?: boolean },
) {
  return run(async () => {
      const detail = await getPayApplication(payApplicationId)
      if (!detail.application.invoice_id) {
        throw new Error("Submit the pay application before generating its package")
      }

      const { fileName, pdf } = await generateSovPayApplicationPdf({ projectId, payApplicationId })
      const pkg = await generateInvoiceBackupPackage({
        projectId,
        invoiceId: detail.application.invoice_id,
        includeGcCompliance: input.includeGcCompliance ?? false,
      })
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return {
        fileName,
        pdfBase64: pdf.toString("base64"),
        package: summarizeOwnerBillingPackage(pkg),
      }
  })
}

export async function releasePrimeRetainageAction(projectId: string, input: RetainageReleaseInput) {
  return run(async () => {
      const detail = await releasePrimeRetainage(projectId, input)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return detail
  })
}

export async function recordGmpContingencyDrawdownAction(input: unknown) {
  return run(async () => {
      const result = await recordGmpContingencyDrawdown(input)
      const projectId = result.summary.project_id
      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/budget`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return result
  })
}

/**
 * Fetch budget breakdown for overview chart
 * - Budget breakdown by cost code/trade
 * - Cost codes for labeling
 */
export async function fetchBudgetBreakdownAction(projectId: string) {
      const [budgetData, costCodes] = await Promise.all([
        getBudgetWithActuals(projectId).catch(() => null),
        listCostCodes().catch(() => []),
      ])

      return {
        breakdown: budgetData?.breakdown ?? [],
        costCodes,
      }
}

export async function fetchBudgetBucketChangeOrdersAction(
  projectId: string,
  bucketId: string | null,
  groupBy: "cost_code" | "budget_line" = "cost_code",
) {
      return listBudgetBucketChangeOrders(projectId, bucketId, groupBy).catch(() => [])
}

export async function fetchBudgetBucketCommitmentsAction(
  projectId: string,
  bucketId?: string | null,
  groupBy: "cost_code" | "budget_line" = "cost_code",
) {
      const commitments = await listProjectCommitments(projectId).catch(() => [])
      if (commitments.length === 0) return []

      const { supabase, orgId } = await requireOrgContext()
      const { data: lines } = await supabase
        .from("commitment_lines")
        .select("commitment_id, cost_code_id, budget_line_id, unit_cost_cents, quantity")
        .eq("org_id", orgId)
        .in("commitment_id", commitments.map((commitment) => commitment.id))

      const linesByCommitment = new Map<string, any[]>()
      for (const line of lines ?? []) {
        const current = linesByCommitment.get(line.commitment_id as string) ?? []
        current.push(line)
        linesByCommitment.set(line.commitment_id as string, current)
      }

      return commitments
        .map((commitment) => {
          const matching = (linesByCommitment.get(commitment.id) ?? []).filter((line) =>
            groupBy === "budget_line"
              ? bucketId
                ? line.budget_line_id === bucketId
                : !line.budget_line_id
              : bucketId
                ? line.cost_code_id === bucketId
                : !line.cost_code_id,
          )
          const allocatedCents = matching.reduce((sum, line) => sum + (line.unit_cost_cents ?? 0) * (line.quantity ?? 1), 0)
          return {
            ...commitment,
            allocated_cents: allocatedCents,
            matching_line_count: matching.length,
          }
        })
        .filter((commitment) => commitment.allocated_cents > 0)
        .sort((a, b) => (b.allocated_cents ?? 0) - (a.allocated_cents ?? 0))
}

export async function generateProjectPurchaseOrdersAction(projectId: string, mode: "dry_run" | "commit") {
  return run(async () => {
    const result = await generatePurchaseOrders({ projectId, mode })
    revalidatePath(`/projects/${projectId}/financials`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    revalidatePath("/purchasing")
    return result
  })
}

export async function loadProjectPoGenerationAction(projectId: string) {
  return run(async () => {
    const [runs, exceptions] = await Promise.all([listGenerationRuns(projectId), listPoExceptions({ projectId, status: "open", pageSize: 1 })])
    return { lastRun: runs[0] ?? null, openExceptions: exceptions.count }
  })
}
