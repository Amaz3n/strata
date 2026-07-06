import type { Contract, Project } from "@/lib/types"

export type ProjectBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials"

export type FinancialLandingPage = "summary" | "review" | "receivables" | "budget" | "forecast"
export type OwnerBillingBasis = "draws" | "costs" | "costs_plus_fee" | "time_materials"
export type FeePresentation = "embedded" | "separate_total" | "separate_by_code"

export interface ProjectFinancialFeatureConfig {
  billingModel: ProjectBillingModel
  landingPage: FinancialLandingPage
  showInbox: boolean
  showTime: boolean
  showExpenses: boolean
  showGenerateFromCosts: boolean
  showOpenBook: boolean
  showDraws: boolean
  showGmpForecast: boolean
  requireCostApproval: boolean
  ownerBillingBasis: OwnerBillingBasis
}

type BillingSource = Pick<Project, "status" | "billing_contract" | "financial_settings"> | Contract | null | undefined

export function isCostDrivenBillingModel(model: ProjectBillingModel) {
  return (
    model === "cost_plus_percent" ||
    model === "cost_plus_fixed_fee" ||
    model === "cost_plus_gmp" ||
    model === "time_and_materials"
  )
}

export function assertApprovedCostInvoiceBillingModelAllowed(model: ProjectBillingModel) {
  if (!isCostDrivenBillingModel(model)) {
    throw new Error("Fixed-price projects cannot create approved-cost invoices. Use draw or contract billing instead.")
  }
}

export function shouldExposeOpenBookCostDetail(openBook?: boolean | null) {
  return openBook !== false
}

export function normalizeFeePresentation(value?: string | null): FeePresentation | null {
  if (value === "embedded" || value === "separate_total" || value === "separate_by_code") return value
  return null
}

export function defaultFeePresentationForBillingModel(model: ProjectBillingModel): FeePresentation {
  return isCostDrivenBillingModel(model) && model !== "time_and_materials" ? "separate_total" : "embedded"
}

export function resolveContractFeePresentation(
  contract: (Contract & { fee_presentation?: string | null }) | Record<string, any> | null | undefined,
): FeePresentation {
  return normalizeFeePresentation(contract?.fee_presentation) ?? normalizeFeePresentation(contract?.snapshot?.fee_presentation) ?? "embedded"
}

function getContract(source: BillingSource, explicitContract?: Contract | null) {
  if (explicitContract) return explicitContract
  if (!source) return null
  if ("contract_type" in source) return source
  if ("billing_contract" in source) return source.billing_contract ?? null
  return null
}

export function resolveProjectBillingModel(source: BillingSource, explicitContract?: Contract | null): ProjectBillingModel {
  if (source && "financial_settings" in source) {
    const explicitModel = source.financial_settings?.billing_model
    if (explicitModel === "cost_plus_fixed_fee") return "cost_plus_fixed_fee"
    if (explicitModel === "cost_plus_gmp") return "cost_plus_gmp"
    if (explicitModel === "cost_plus_percent") return "cost_plus_percent"
    if (explicitModel === "time_and_materials") return "time_and_materials"
    if (explicitModel === "fixed_price") return "fixed_price"
  }

  const contract = getContract(source, explicitContract)
  const rawType = contract?.contract_type
  const snapshotModel = typeof contract?.snapshot?.billing_model === "string" ? contract.snapshot.billing_model : null

  if (snapshotModel === "cost_plus_fixed_fee") return "cost_plus_fixed_fee"
  if (snapshotModel === "cost_plus_gmp") return "cost_plus_gmp"
  if (snapshotModel === "cost_plus_percent") return "cost_plus_percent"
  if (snapshotModel === "time_and_materials") return "time_and_materials"
  if (snapshotModel === "fixed_price") return "fixed_price"

  if (rawType === "time_materials") return "time_and_materials"
  if (rawType === "cost_plus") {
    if (contract?.fixed_fee_cents) return "cost_plus_fixed_fee"
    return contract?.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent"
  }

  return "fixed_price"
}

export function getProjectFinancialFeatureConfig(
  source: BillingSource,
  explicitContract?: Contract | null,
): ProjectFinancialFeatureConfig {
  const contract = getContract(source, explicitContract)
  const billingModel = resolveProjectBillingModel(source, contract)
  const isCostPlus = billingModel === "cost_plus_percent" || billingModel === "cost_plus_fixed_fee" || billingModel === "cost_plus_gmp"
  const isTimeAndMaterials = billingModel === "time_and_materials"
  const isCostDriven = isCostDrivenBillingModel(billingModel)

  if (billingModel === "fixed_price") {
    return {
      billingModel,
      landingPage: "summary",
      showInbox: false,
      showTime: false,
      showExpenses: false,
      showGenerateFromCosts: false,
      showOpenBook: false,
      showDraws: true,
      showGmpForecast: false,
      requireCostApproval: false,
      ownerBillingBasis: "draws",
    }
  }

  if (billingModel === "cost_plus_fixed_fee") {
    return {
      billingModel,
      landingPage: "summary",
      showInbox: true,
      showTime: true,
      showExpenses: true,
      showGenerateFromCosts: true,
      showOpenBook: shouldExposeOpenBookCostDetail(contract?.open_book),
      showDraws: false,
      showGmpForecast: false,
      requireCostApproval: contract?.requires_client_cost_approval === true,
      ownerBillingBasis: "costs_plus_fee",
    }
  }

  if (billingModel === "cost_plus_gmp") {
    return {
      billingModel,
      landingPage: "summary",
      showInbox: true,
      showTime: true,
      showExpenses: true,
      showGenerateFromCosts: true,
      showOpenBook: shouldExposeOpenBookCostDetail(contract?.open_book),
      showDraws: false,
      showGmpForecast: true,
      requireCostApproval: contract?.requires_client_cost_approval === true,
      ownerBillingBasis: "costs",
    }
  }

  return {
    billingModel,
    landingPage: "summary",
    showInbox: true,
    showTime: true,
    showExpenses: true,
    showGenerateFromCosts: isCostDriven,
    showOpenBook: isCostPlus ? shouldExposeOpenBookCostDetail(contract?.open_book) : false,
    showDraws: false,
    showGmpForecast: false,
    requireCostApproval: contract?.requires_client_cost_approval === true,
    ownerBillingBasis: isTimeAndMaterials ? "time_materials" : "costs",
  }
}

export function supportsApprovedCostInvoicing(source: BillingSource, explicitContract?: Contract | null) {
  return getProjectFinancialFeatureConfig(source, explicitContract).showGenerateFromCosts
}
