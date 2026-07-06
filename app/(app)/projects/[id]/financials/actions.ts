"use server"

import { revalidatePath } from "next/cache"

import { getBudgetWithActuals, listBudgetBucketChangeOrders, listProjectBudgetLines, listVarianceAlertsForProject } from "@/lib/services/budgets"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listProjectCommitments } from "@/lib/services/commitments"
import { listCompanies } from "@/lib/services/companies"
import { getProjectInvoiceArSummary, listInvoices } from "@/lib/services/invoices"
import { listContacts } from "@/lib/services/contacts"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"
import { getProjectBuyoutStatus } from "@/lib/services/bids"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import {
  generateInvoiceFromCosts,
} from "@/lib/services/cost-plus"
import { generateInvoiceFromCostsInputSchema } from "@/lib/validation/cost-plus"
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
import { getProjectGmpControlSummary, recordGmpContingencyDrawdown } from "@/lib/services/gmp-control"
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
import { prepareBillingAutopilotRun } from "@/lib/services/billing-autopilot"
import { requireOrgContext } from "@/lib/services/context"

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
 * - Companies (for commitment vendor selection)
 */
export async function fetchBudgetTabDataAction(projectId: string) {
  const setupStatus = await getProjectFinancialSetupStatusForProject(projectId).catch(() => null)
  const isFixedPrice = setupStatus?.billingModel === "fixed_price"
  const [
    budgetDataResult,
    costCodesResult,
    varianceAlertsResult,
    commitmentsResult,
    companiesResult,
    buyoutStatusResult,
    feeSummaryResult,
    gmpSummaryResult,
  ] = await Promise.allSettled([
    getBudgetWithActuals(projectId),
    listCostCodes(),
    listVarianceAlertsForProject(projectId),
    listProjectCommitments(projectId),
    listCompanies(),
    getProjectBuyoutStatus(projectId),
    isFixedPrice ? Promise.resolve(null) : getProjectFeeBillingSummary(projectId),
    isFixedPrice ? Promise.resolve(null) : getProjectGmpControlSummary(projectId),
  ])

  const budgetData = budgetDataResult.status === "fulfilled" ? budgetDataResult.value : null
  const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
  const varianceAlerts = varianceAlertsResult.status === "fulfilled" ? varianceAlertsResult.value : []
  const commitments = commitmentsResult.status === "fulfilled" ? commitmentsResult.value : []
  const companies = companiesResult.status === "fulfilled" ? companiesResult.value : []
  const errors = [
    resultError("Budget", budgetDataResult),
    resultError("Cost codes", costCodesResult),
    resultError("Variance alerts", varianceAlertsResult),
    resultError("Commitments", commitmentsResult),
    resultError("Companies", companiesResult),
    resultError("Buyout status", buyoutStatusResult),
    isFixedPrice ? null : resultError("Fee billing", feeSummaryResult),
    isFixedPrice ? null : resultError("GMP control", gmpSummaryResult),
  ].filter(Boolean) as string[]
  const budgetBucketCompanies = await buildBudgetBucketCompanies(commitments)

  return {
    budgetData,
    costCodes,
    varianceAlerts,
    commitments,
    companies,
    buyoutStatus: buyoutStatusResult.status === "fulfilled" ? buyoutStatusResult.value : null,
    budgetBucketCompanies,
    feeSummary: feeSummaryResult.status === "fulfilled" ? feeSummaryResult.value : null,
    gmpSummary: gmpSummaryResult.status === "fulfilled" ? gmpSummaryResult.value : null,
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
export async function fetchReceivablesTabDataAction(projectId: string) {
  const setupStatus = await getProjectFinancialSetupStatusForProject(projectId).catch(() => null)
  const isFixedPrice = setupStatus?.billingModel === "fixed_price"
  const isFixedFee = setupStatus?.billingModel === "cost_plus_fixed_fee"
  const [invoicesResult, contactsResult, costCodesResult, ownerPackagesResult, feeSummaryResult, arSummaryResult] = await Promise.allSettled([
    // First page only; the invoices tab lazy-loads the rest via "Load more".
    listInvoices({ projectId, limit: 100 }),
    listContacts(),
    listCostCodes(),
    isFixedPrice ? Promise.resolve([]) : listProjectOwnerBillingPackageSummaries(projectId),
    isFixedFee ? getProjectFeeBillingSummary(projectId) : Promise.resolve(null),
    // Whole-book aging so the AR strip stays correct beyond the first invoice page.
    getProjectInvoiceArSummary({ projectId }),
  ])

  return {
    invoices: invoicesResult.status === "fulfilled" ? invoicesResult.value : [],
    contacts: contactsResult.status === "fulfilled" ? contactsResult.value : [],
    costCodes: costCodesResult.status === "fulfilled" ? costCodesResult.value : [],
    ownerBillingPackages: ownerPackagesResult.status === "fulfilled" ? ownerPackagesResult.value : [],
    feeSummary: feeSummaryResult.status === "fulfilled" ? feeSummaryResult.value : null,
    arSummary: arSummaryResult.status === "fulfilled" ? arSummaryResult.value : null,
    errors: [
      resultError("Invoices", invoicesResult),
      resultError("Contacts", contactsResult),
      resultError("Cost codes", costCodesResult),
      isFixedPrice ? null : resultError("Owner billing packages", ownerPackagesResult),
      isFixedFee ? resultError("Fee billing", feeSummaryResult) : null,
    ].filter(Boolean) as string[],
  }
}

export async function prepareBillingAutopilotAction(projectId: string) {
  const state = await prepareBillingAutopilotRun(projectId)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
  return state
}

/**
 * Fetch all data needed for the Payables tab
 * - Vendor bills for the project
 * - Compliance rules for payment blocking
 */
export async function fetchPayablesTabDataAction(projectId: string) {
  const [vendorBillsResult, complianceRulesResult, costCodesResult, budgetLinesResult] = await Promise.allSettled([
    listVendorBillsForProject(projectId),
    getComplianceRules(),
    listCostCodes(),
    listProjectBudgetLines(projectId),
  ])

  const vendorBills = vendorBillsResult.status === "fulfilled" ? vendorBillsResult.value : []
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
  const companyIds = Array.from(new Set(vendorBills.map((b) => b.company_id).filter(Boolean))) as string[]
  const complianceStatusResult = await Promise.allSettled([getCompaniesComplianceStatus(companyIds)])
  const complianceStatusByCompanyId =
    complianceStatusResult[0].status === "fulfilled" ? complianceStatusResult[0].value : {}

  return {
    vendorBills,
    complianceRules,
    complianceStatusByCompanyId,
    costCodes,
    budgetLines,
    errors: [
      resultError("Vendor bills", vendorBillsResult),
      resultError("Compliance rules", complianceRulesResult),
      resultError("Cost codes", costCodesResult),
      resultError("Compliance status", complianceStatusResult[0]),
    ].filter(Boolean) as string[],
  }
}

export async function generateInvoiceFromCostsAction(input: unknown) {
  const parsed = generateInvoiceFromCostsInputSchema.parse(input)
  const result = await generateInvoiceFromCosts(parsed)
  if (!parsed.dryRun) {
    revalidatePath(`/projects/${parsed.projectId}`)
    revalidatePath(`/projects/${parsed.projectId}/financials`)
    revalidatePath(`/projects/${parsed.projectId}/financials/review`)
    revalidatePath(`/projects/${parsed.projectId}/financials/receivables`)
  }
  return result
}

export async function saveProjectFinancialSetupAction(input: FinancialSetupInput) {
  const result = await saveProjectFinancialSetup(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/budget`)
  revalidatePath(`/projects/${input.projectId}/financials/payables`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return result
}

export async function createTmTicketAction(input: {
  projectId: string
  workDate: string
  billableCostIds?: string[]
  notes?: string | null
}) {
  const ticket = await createTmTicket({
    projectId: input.projectId,
    workDate: new Date(`${input.workDate}T00:00:00`),
    billableCostIds: input.billableCostIds,
    notes: input.notes ?? null,
  })
  revalidatePath(`/projects/${input.projectId}/financials/review`)
  revalidatePath(`/projects/${input.projectId}/financials/tm-tickets`)
  return ticket
}

export async function submitTmTicketAction(projectId: string, ticketId: string) {
  const ticket = await submitTmTicket(ticketId)
  revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
  return ticket
}

export async function createTmTicketSignatureLinkAction(projectId: string, ticketId: string) {
  const link = await createTmTicketSignatureLink(ticketId)
  revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
  return link
}

export async function generateInvoiceFromTmTicketAction(projectId: string, ticketId: string) {
  const result = await generateInvoiceFromTmTicket(ticketId)
  revalidatePath(`/projects/${projectId}/financials/review`)
  revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
  return result
}

export async function voidTmTicketAction(projectId: string, ticketId: string) {
  const ticket = await voidTmTicket(ticketId)
  revalidatePath(`/projects/${projectId}/financials/tm-tickets`)
  return ticket
}

export async function createProjectBillingPeriodAction(input: CreateBillingPeriodInput) {
  const period = await createProjectBillingPeriod(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/review`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return period
}

export async function closeProjectBillingPeriodAction(input: CloseBillingPeriodInput) {
  const period = await closeProjectBillingPeriod(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/review`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return period
}

export async function generateOwnerBillingPackageAction(input: { projectId: string; invoiceId: string }) {
  const pkg = await generateInvoiceBackupPackage(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/review`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return summarizeOwnerBillingPackage(pkg)
}

export async function shareOwnerBillingPackageAction(input: { projectId: string; packageId: string }) {
  const pkg = await shareInvoiceBackupPackage(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return summarizeOwnerBillingPackage(pkg)
}

export async function updateProjectFeeProgressAction(input: UpdateFeeProgressInput) {
  const summary = await updateProjectFeeProgress(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/budget`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return summary
}

export async function createProjectFeeInvoiceAction(input: CreateFeeInvoiceInput) {
  const invoice = await createProjectFeeInvoice(input)
  const feeSummary = await getProjectFeeBillingSummary(input.projectId)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/budget`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return { invoice, feeSummary }
}

export async function recordGmpContingencyDrawdownAction(input: unknown) {
  const result = await recordGmpContingencyDrawdown(input)
  const projectId = result.summary.project_id
  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/budget`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
  return result
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
