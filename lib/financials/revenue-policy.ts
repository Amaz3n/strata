import type { Project } from "@/lib/types"
import {
  getProjectFinancialFeatureConfig,
  type BillingContractSource,
  resolveRevenueRecognitionBasis,
  type ProjectBillingModel,
  type RevenueRecognitionBasis,
} from "@/lib/financials/billing-model"

/**
 * How a job earns revenue, as a dated record (B11.1). Billing method and
 * recognition method are different things: a cost-plus job bills its costs but
 * still earns cost-to-cost; a home sold under a purchase agreement earns at the
 * closing however it was billed.
 */
export type RevenueBillingMethod = ProjectBillingModel | "purchase_agreement"

/**
 * The method each kind of work earns under until someone approves otherwise.
 * Standalone services (an invoice with no project) earn when invoiced; that is
 * `invoiceRevenueBasis`, not a project policy.
 */
export const DEFAULT_REVENUE_METHOD: Record<RevenueBillingMethod, RevenueRecognitionBasis> = {
  fixed_price: "percentage_of_completion",
  cost_plus_percent: "percentage_of_completion",
  cost_plus_fixed_fee: "percentage_of_completion",
  cost_plus_gmp: "percentage_of_completion",
  time_and_materials: "percentage_of_completion",
  purchase_agreement: "closing",
}

export const REVENUE_METHOD_LABELS: Record<RevenueRecognitionBasis, string> = {
  percentage_of_completion: "Percentage of completion",
  closing: "At closing",
}

export const BILLING_METHOD_LABELS: Record<RevenueBillingMethod, string> = {
  fixed_price: "Fixed price",
  cost_plus_percent: "Cost plus percentage",
  cost_plus_fixed_fee: "Cost plus fixed fee",
  cost_plus_gmp: "Cost plus, GMP",
  time_and_materials: "Time and materials",
  purchase_agreement: "Purchase agreement",
}

export type RevenuePolicyRecord = {
  id: string
  project_id: string
  contract_id: string | null
  method: RevenueRecognitionBasis
  billing_method: RevenueBillingMethod
  effective_from: string
  status: "inferred" | "proposed" | "approved" | "rejected"
  reviewed_at: string | null
}

export type AppliedRevenuePolicy = {
  method: RevenueRecognitionBasis
  billingMethod: RevenueBillingMethod
  /** `approved`: reviewed. `inferred`: recorded by Arc, not reviewed. `unrecorded`: inferred now, to be recorded. */
  source: "approved" | "inferred" | "unrecorded"
  policyId: string | null
}

/**
 * The policy in force for a project (or one contract of it) on a date:
 * an approved policy effective by then, the contract's before the project's;
 * otherwise the inferred baseline, the contract's before the project's.
 */
export function policyInForce(records: readonly RevenuePolicyRecord[], projectId: string, contractId: string | null, date: string): RevenuePolicyRecord | null {
  const ofScope = (scope: string | null) => records.filter(row => row.project_id === projectId && row.contract_id === scope)
  const approved = (rows: RevenuePolicyRecord[]) => rows
    .filter(row => row.status === "approved" && row.effective_from <= date)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "") || b.id.localeCompare(a.id))[0]
  const inferred = (rows: RevenuePolicyRecord[]) => rows.find(row => row.status === "inferred")
  const contract = contractId ? ofScope(contractId) : []
  const project = ofScope(null)
  return approved(contract) ?? approved(project) ?? inferred(contract) ?? inferred(project) ?? null
}

type InferenceProject = {
  status?: Project["status"]
  property_type?: Project["property_type"]
  financial_settings?: { billing_model?: ProjectBillingModel; fixed_price_billing_basis?: "draws" | "progress" | null } | null
}

/** What the billing settings say today, for a job with no recorded policy. */
export function inferRevenuePolicy(project: InferenceProject, contract: BillingContractSource | null): { method: RevenueRecognitionBasis; billingMethod: RevenueBillingMethod } {
  const config = getProjectFinancialFeatureConfig({ ...project, billing_contract: contract })
  const method = resolveRevenueRecognitionBasis(config)
  return { method, billingMethod: method === "closing" ? "purchase_agreement" : config.billingModel }
}
