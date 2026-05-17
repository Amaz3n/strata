import { listCostCodes } from "@/lib/services/cost-codes"
import { listCostPlusTabData } from "@/lib/services/cost-plus"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"

export type FinancialsReviewQueueData = Awaited<ReturnType<typeof loadFinancialsReviewQueueData>>

export async function loadFinancialsReviewQueueData(projectId: string) {
  const [costPlusResult, vendorBillsResult, costCodesResult] = await Promise.allSettled([
    listCostPlusTabData(projectId),
    listVendorBillsForProject(projectId),
    listCostCodes(),
  ])

  const errors = [
    resultError("Cost-plus ledger", costPlusResult),
    resultError("Vendor bills", vendorBillsResult),
    resultError("Cost codes", costCodesResult),
  ].filter(Boolean) as string[]

  const costPlusData =
    costPlusResult.status === "fulfilled"
      ? costPlusResult.value
      : { billableCosts: [], timeEntries: [], expenses: [], gmpSnapshot: null }
  const vendorBills = vendorBillsResult.status === "fulfilled" ? vendorBillsResult.value : []
  const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []

  return {
    timeEntries: (costPlusData.timeEntries ?? []).filter((entry: any) =>
      ["submitted", "pm_approved"].includes(entry.status),
    ),
    expenses: (costPlusData.expenses ?? []).filter((expense: any) =>
      ["draft", "submitted"].includes(expense.status),
    ),
    vendorBills: vendorBills.filter((bill) => bill.status === "pending"),
    openCosts: (costPlusData.billableCosts ?? []).filter((cost: any) => cost.status === "open" && cost.is_billable),
    costCodes,
    errors,
  }
}

function resultError(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "Unknown error")
  return `${label}: ${message}`
}
