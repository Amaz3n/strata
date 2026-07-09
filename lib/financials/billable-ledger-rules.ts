import {
  isCostDrivenBillingModel,
  type ProjectBillingModel,
} from "@/lib/financials/billing-model"

export type BillableLedgerSourceType = "vendor_bill_line" | "project_expense" | "time_entry"

export function assertCostSourceCanEnterBillableLedger(params: {
  billingModel: ProjectBillingModel
  sourceType: BillableLedgerSourceType
  sourceStatus: string
  clientCostApprovalRequired?: boolean | null
}) {
  if (!isCostDrivenBillingModel(params.billingModel)) {
    throw new Error("Only cost-driven projects can move source costs into the billable ledger.")
  }

  if (params.sourceType === "vendor_bill_line" && !["approved", "partial", "paid"].includes(params.sourceStatus)) {
    throw new Error("Vendor bill must be approved before it enters the billable ledger.")
  }

  if (params.sourceType === "project_expense" && params.sourceStatus !== "approved") {
    throw new Error("Expense must be approved before it enters the billable ledger.")
  }

  if (params.sourceType === "time_entry") {
    const allowedStatuses = params.clientCostApprovalRequired ? ["client_approved"] : ["pm_approved", "client_approved"]
    if (!allowedStatuses.includes(params.sourceStatus)) throw new Error("Time entry is not approved for billing.")
  }
}
