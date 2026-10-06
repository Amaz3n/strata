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

/** Never let row order, draft negotiations or child amendments choose the ledger posture. */
export function resolveProjectRevenueBasis(
  project: RevenueProject,
  contracts: readonly RevenueContract[],
  asOf: string,
): RevenueRecognitionBasis {
  const primaryContracts = contracts.filter(contract =>
    contract.project_id === project.id &&
    contract.parent_contract_id == null &&
    EARNING_CONTRACT_STATUSES.has(contract.status) &&
    (!contract.effective_date || contract.effective_date <= asOf),
  )
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
