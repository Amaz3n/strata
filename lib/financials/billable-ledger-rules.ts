import {
  isCostDrivenBillingModel,
  type ProjectBillingModel,
} from "@/lib/financials/billing-model"
import { PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"

export type BillableLedgerSourceType = "vendor_bill_line" | "project_expense" | "time_entry"

export function assertCostSourceCanEnterBillableLedger(params: {
  billingModel: ProjectBillingModel
  sourceType: BillableLedgerSourceType
  sourceStatus: string
  clientCostApprovalRequired?: boolean | null
  // Time only: the client approved the cost (its status, or its stamp once the
  // entry is locked into a closed pay period).
  clientApproved?: boolean
}) {
  if (!isCostDrivenBillingModel(params.billingModel)) {
    throw new Error("Only cost-driven projects can move source costs into the billable ledger.")
  }

  if (
    params.sourceType === "vendor_bill_line" &&
    !(PAYABLE_VENDOR_BILL_STATUSES as readonly string[]).includes(params.sourceStatus)
  ) {
    throw new Error("Vendor bill must be approved before it enters the billable ledger.")
  }

  if (params.sourceType === "project_expense" && params.sourceStatus !== "approved") {
    throw new Error("Expense must be approved before it enters the billable ledger.")
  }

  if (params.sourceType === "time_entry") {
    const approved = ["pm_approved", "client_approved", "locked"].includes(params.sourceStatus)
    const clientApproved = params.clientApproved ?? params.sourceStatus === "client_approved"
    if (!approved || (params.clientCostApprovalRequired && !clientApproved)) {
      throw new Error("Time entry is not approved for billing.")
    }
  }
}
