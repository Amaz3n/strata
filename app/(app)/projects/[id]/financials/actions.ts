"use server"

import { revalidatePath } from "next/cache"

import { getBudgetWithActuals, listVarianceAlertsForProject } from "@/lib/services/budgets"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listCommitmentLines, listProjectCommitments } from "@/lib/services/commitments"
import { listCompanies } from "@/lib/services/companies"
import { listInvoices } from "@/lib/services/invoices"
import { listContacts } from "@/lib/services/contacts"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import {
  generateInvoiceFromCosts,
} from "@/lib/services/cost-plus"
import { generateInvoiceFromCostsInputSchema } from "@/lib/validation/cost-plus"
import { createProjectBillingPeriod, type CreateBillingPeriodInput } from "@/lib/services/billing-periods"
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
import { getProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { saveProjectFinancialSetup, type FinancialSetupInput } from "@/lib/services/project-financial-setup"

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
  const [budgetDataResult, costCodesResult, varianceAlertsResult, commitmentsResult, companiesResult, feeSummaryResult, gmpSummaryResult] = await Promise.allSettled([
    getBudgetWithActuals(projectId),
    listCostCodes(),
    listVarianceAlertsForProject(projectId),
    listProjectCommitments(projectId),
    listCompanies(),
    getProjectFeeBillingSummary(projectId),
    getProjectGmpControlSummary(projectId),
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
    resultError("Fee billing", feeSummaryResult),
    resultError("GMP control", gmpSummaryResult),
  ].filter(Boolean) as string[]
  const budgetBucketCompanies = await buildBudgetBucketCompanies(commitments)

  return {
    budgetData,
    costCodes,
    varianceAlerts,
    commitments,
    companies,
    budgetBucketCompanies,
    feeSummary: feeSummaryResult.status === "fulfilled" ? feeSummaryResult.value : null,
    gmpSummary: gmpSummaryResult.status === "fulfilled" ? gmpSummaryResult.value : null,
    errors,
  }
}

async function buildBudgetBucketCompanies(commitments: Awaited<ReturnType<typeof listProjectCommitments>>) {
  if (commitments.length === 0) return {}

  const companyNamesByBucket = new Map<string, Set<string>>()
  const commitmentLines = await Promise.all(
    commitments.map(async (commitment) => ({
      commitment,
      lines: await listCommitmentLines(commitment.id).catch(() => []),
    })),
  )

  for (const { commitment, lines } of commitmentLines) {
    const companyName = commitment.company_name?.trim()
    if (!companyName) continue

    for (const line of lines) {
      const key = line.cost_code_id ?? "uncoded"
      const names = companyNamesByBucket.get(key) ?? new Set<string>()
      names.add(companyName)
      companyNamesByBucket.set(key, names)
    }
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
  const [invoicesResult, contactsResult, costCodesResult, ownerPackagesResult, feeSummaryResult, gmpSummaryResult] = await Promise.allSettled([
    listInvoices({ projectId }),
    listContacts(),
    listCostCodes(),
    listProjectOwnerBillingPackageSummaries(projectId),
    getProjectFeeBillingSummary(projectId),
    getProjectGmpControlSummary(projectId),
  ])

  return {
    invoices: invoicesResult.status === "fulfilled" ? invoicesResult.value : [],
    contacts: contactsResult.status === "fulfilled" ? contactsResult.value : [],
    costCodes: costCodesResult.status === "fulfilled" ? costCodesResult.value : [],
    ownerBillingPackages: ownerPackagesResult.status === "fulfilled" ? ownerPackagesResult.value : [],
    feeSummary: feeSummaryResult.status === "fulfilled" ? feeSummaryResult.value : null,
    gmpSummary: gmpSummaryResult.status === "fulfilled" ? gmpSummaryResult.value : null,
    errors: [
      resultError("Invoices", invoicesResult),
      resultError("Contacts", contactsResult),
      resultError("Cost codes", costCodesResult),
      resultError("Owner billing packages", ownerPackagesResult),
      resultError("Fee billing", feeSummaryResult),
      resultError("GMP control", gmpSummaryResult),
    ].filter(Boolean) as string[],
  }
}

/**
 * Fetch all data needed for the Payables tab
 * - Vendor bills for the project
 * - Compliance rules for payment blocking
 */
export async function fetchPayablesTabDataAction(projectId: string) {
  const [vendorBillsResult, complianceRulesResult, costCodesResult] = await Promise.allSettled([
    listVendorBillsForProject(projectId),
    getComplianceRules(),
    listCostCodes(),
  ])

  const vendorBills = vendorBillsResult.status === "fulfilled" ? vendorBillsResult.value : []
  const complianceRules =
    complianceRulesResult.status === "fulfilled"
      ? complianceRulesResult.value
      : {
          require_lien_waiver: false,
          block_payment_on_missing_docs: true,
        }
  const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
  const companyIds = Array.from(new Set(vendorBills.map((b) => b.company_id).filter(Boolean))) as string[]
  const complianceStatusResult = await Promise.allSettled([getCompaniesComplianceStatus(companyIds)])
  const complianceStatusByCompanyId =
    complianceStatusResult[0].status === "fulfilled" ? complianceStatusResult[0].value : {}

  return {
    vendorBills,
    complianceRules,
    complianceStatusByCompanyId,
    costCodes,
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
  return generateInvoiceFromCosts(parsed)
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

export async function createProjectBillingPeriodAction(input: CreateBillingPeriodInput) {
  const period = await createProjectBillingPeriod(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
  revalidatePath(`/projects/${input.projectId}/financials/receivables`)
  return period
}

export async function generateOwnerBillingPackageAction(input: { projectId: string; invoiceId: string }) {
  const pkg = await generateInvoiceBackupPackage(input)
  revalidatePath(`/projects/${input.projectId}`)
  revalidatePath(`/projects/${input.projectId}/financials`)
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

export async function fetchBudgetBucketCommitmentsAction(projectId: string, costCodeId?: string | null) {
  const commitments = await listProjectCommitments(projectId).catch(() => [])
  if (commitments.length === 0) return []

  const commitmentLines = await Promise.all(
    commitments.map(async (commitment) => ({
      commitment,
      lines: await listCommitmentLines(commitment.id).catch(() => []),
    })),
  )

  return commitmentLines
    .map(({ commitment, lines }) => {
      const matching = lines.filter((line) =>
        costCodeId ? line.cost_code_id === costCodeId : !line.cost_code_id,
      )
      const allocatedCents = matching.reduce((sum, line) => sum + (line.total_cents ?? 0), 0)
      return {
        ...commitment,
        allocated_cents: allocatedCents,
        matching_line_count: matching.length,
      }
    })
    .filter((commitment) => commitment.allocated_cents > 0)
    .sort((a, b) => (b.allocated_cents ?? 0) - (a.allocated_cents ?? 0))
}
