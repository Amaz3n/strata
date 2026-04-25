"use server"

import { getBudgetWithActuals, listVarianceAlertsForProject } from "@/lib/services/budgets"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listCommitmentLines, listProjectCommitments } from "@/lib/services/commitments"
import { listCompanies } from "@/lib/services/companies"
import { listInvoices } from "@/lib/services/invoices"
import { listContacts } from "@/lib/services/contacts"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"

/**
 * Fetch all data needed for the Budget tab
 * - Budget data with actuals
 * - Cost codes for line item assignment
 * - Variance alerts
 * - Commitments (merged into budget tab)
 * - Companies (for commitment vendor selection)
 */
export async function fetchBudgetTabDataAction(projectId: string) {
  const [budgetData, costCodes, varianceAlerts, commitments, companies] = await Promise.all([
    getBudgetWithActuals(projectId).catch(() => null),
    listCostCodes().catch(() => []),
    listVarianceAlertsForProject(projectId).catch(() => []),
    listProjectCommitments(projectId).catch(() => []),
    listCompanies().catch(() => []),
  ])

  return {
    budgetData,
    costCodes,
    varianceAlerts,
    commitments,
    companies,
  }
}

/**
 * Fetch all data needed for the Receivables tab
 * - Invoices for the project
 * - Contacts for invoice recipients
 * - Cost codes for invoice line items
 */
export async function fetchReceivablesTabDataAction(projectId: string) {
  const [invoices, contacts, costCodes] = await Promise.all([
    listInvoices({ projectId }).catch(() => []),
    listContacts().catch(() => []),
    listCostCodes().catch(() => []),
  ])

  return {
    invoices,
    contacts,
    costCodes,
  }
}

/**
 * Fetch all data needed for the Payables tab
 * - Vendor bills for the project
 * - Compliance rules for payment blocking
 */
export async function fetchPayablesTabDataAction(projectId: string) {
  const [vendorBills, complianceRules] = await Promise.all([
    listVendorBillsForProject(projectId).catch(() => []),
    getComplianceRules().catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
    })),
  ])

  const companyIds = Array.from(new Set(vendorBills.map((b) => b.company_id).filter(Boolean))) as string[]
  const complianceStatusByCompanyId = await getCompaniesComplianceStatus(companyIds).catch(() => ({}))

  return {
    vendorBills,
    complianceRules,
    complianceStatusByCompanyId,
  }
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
