import {
  getProjectFinancialFeatureConfig,
  resolveRevenueRecognitionBasis,
  type ProjectBillingModel,
  type RevenueRecognitionBasis,
} from "@/lib/financials/billing-model"
import type { Contract, Project } from "@/lib/types"

type RevenueContract = Pick<Contract, "id" | "status" | "project_id" | "parent_contract_id" | "effective_date"> &
  Partial<Pick<Contract, "contract_type" | "fixed_fee_cents" | "gmp_cents" | "snapshot" | "open_book" | "requires_client_cost_approval">>

type RevenueProject = {
  id: string
  status?: Project["status"]
  property_type?: Project["property_type"]
  financial_settings?: {
    billing_model?: ProjectBillingModel
    fixed_price_billing_basis?: "draws" | "progress" | null
  } | null
}

const EARNING_CONTRACT_STATUSES = new Set(["active", "amended", "completed", "terminated"])

/**
 * A project's primary contracts in force on a date: signed (not draft or
 * superseded), not an amendment of another, and effective by then. Ordered by
 * id so no caller depends on row order. More than one means WIP is per contract.
 */
export function primaryContractsInForce<T extends { id: string; status: string; project_id: string; parent_contract_id?: string | null; effective_date?: string | null }>(
  projectId: string,
  contracts: readonly T[],
  asOf: string,
): T[] {
  return contracts.filter(contract =>
    contract.project_id === projectId &&
    contract.parent_contract_id == null &&
    EARNING_CONTRACT_STATUSES.has(contract.status) &&
    (!contract.effective_date || contract.effective_date <= asOf),
  ).sort((a, b) => a.id.localeCompare(b.id))
}

/** Never let row order, draft negotiations or child amendments choose the ledger posture. */
export function resolveProjectRevenueBasis(
  project: RevenueProject,
  contracts: readonly RevenueContract[],
  asOf: string,
): RevenueRecognitionBasis {
  const primaryContracts = primaryContractsInForce(project.id, contracts, asOf)
  if (!primaryContracts.length && contracts.some(contract =>
    contract.project_id === project.id && contract.parent_contract_id == null &&
    contract.status === "superseded" && (!contract.effective_date || contract.effective_date <= asOf),
  )) {
    throw new Error(`Project ${project.id} has only superseded contract evidence at ${asOf}. Historical revenue-policy evidence is required before posting or closing Books.`)
  }
  const bases = new Set((primaryContracts.length ? primaryContracts : [null]).map(contract =>
    resolveRevenueRecognitionBasis(getProjectFinancialFeatureConfig({
      status: project.status,
      property_type: project.property_type,
      financial_settings: project.financial_settings,
      billing_contract: contract,
    })),
  ))
  if (bases.size !== 1) {
    throw new Error(`Project ${project.id} has conflicting primary contract revenue bases. Resolve the contract scope before posting or closing Books.`)
  }
  return bases.values().next().value!
}
