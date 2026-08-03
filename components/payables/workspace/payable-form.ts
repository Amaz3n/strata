import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import { isVendorCredit, payableOutstandingCents } from "@/lib/financials/payables-rules"
import type { CostCode } from "@/lib/types"

export type VendorBillStatus = "pending" | "approved" | "partial" | "paid"

/** Narrow the summary's loose status string to the real lifecycle enum. */
export function billStatus(bill: VendorBillSummary): VendorBillStatus {
  const status = bill.status
  if (status === "approved" || status === "partial" || status === "paid") return status
  return "pending"
}

/**
 * Where a payable sits on its way to the vendor being paid. This single stage
 * drives which sections render, which fields are editable, and which one
 * primary action the workspace offers.
 */
export type PayableStage = "credit" | "review" | "in_run" | "payable" | "paid"

export function payableStage(bill: VendorBillSummary, runMembership?: PayableRunMembership): PayableStage {
  if (isVendorCredit(bill)) return "credit"
  const status = billStatus(bill)
  if (status === "pending") return "review"
  if (runMembership) return "in_run"
  if (status === "paid" && payableOutstandingCents(bill) <= 0) return "paid"
  return "payable"
}

export type SplitLine = {
  id: string
  projectId: string
  costCodeId: string
  budgetLineId: string
  description: string
  amountDollars: string
  qboExpenseAccountId: string
  qboApAccountId: string
  billableToCustomer: boolean
}

export interface PayableFormState {
  billNumber: string
  billDate: string
  dueDate: string
  retainage: string
  lienWaiver: string
  qboExpenseAccountId: string
  qboApAccountId: string
  splitLines: SplitLine[]
}

export function normalizeLienWaiverStatus(status?: string | null) {
  if (status === "requested" || status === "received" || status === "not_required") return status
  if (status === "pending") return "requested"
  return "not_required"
}

interface FormContext {
  costCodesEnabled: boolean
  qboDefaults: { expenseAccountId?: string; apAccountId?: string }
  defaultBillable: (projectId?: string | null) => boolean
}

/**
 * The single baseline for the editable form: what the inputs show when the bill
 * is first opened, and what "dirty" is measured against. Both consumers use this
 * one builder so the two can never drift apart.
 */
export function toFormState(bill: VendorBillSummary, { costCodesEnabled, qboDefaults, defaultBillable }: FormContext): PayableFormState {
  const existing = bill.actual_lines ?? []
  const splitLines: SplitLine[] =
    existing.length > 0
      ? existing.map((line, index) => ({
          id: line.id ?? `line-${index}`,
          projectId: line.project_id ?? bill.project_id,
          costCodeId: line.cost_code_id ?? "",
          budgetLineId: line.budget_line_id ?? "",
          description: line.description ?? bill.bill_number ?? "Vendor bill",
          amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
          qboExpenseAccountId: line.qbo_expense_account_id ?? bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
          qboApAccountId: line.qbo_ap_account_id ?? bill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
          billableToCustomer: line.billable_to_customer === true,
        }))
      : [
          {
            id: "line-0",
            projectId: bill.project_id,
            // No silent default: an untouched picker must not code the bill.
            costCodeId: costCodesEnabled ? bill.actual_cost_code_id ?? "" : "",
            budgetLineId: "",
            description: bill.bill_number ?? "Vendor bill",
            amountDollars: ((bill.total_cents ?? 0) / 100).toFixed(2),
            qboExpenseAccountId: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
            qboApAccountId: bill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
            billableToCustomer: defaultBillable(bill.project_id),
          },
        ]
  return {
    billNumber: bill.bill_number ?? "",
    billDate: bill.bill_date ?? "",
    dueDate: bill.due_date ?? "",
    retainage: bill.retainage_percent != null ? String(bill.retainage_percent) : "",
    lienWaiver: normalizeLienWaiverStatus(bill.lien_waiver_status),
    qboExpenseAccountId: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
    qboApAccountId: bill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "",
    splitLines,
  }
}

export function formIsDirty(state: PayableFormState, baseline: PayableFormState): boolean {
  if (
    state.billNumber !== baseline.billNumber ||
    state.billDate !== baseline.billDate ||
    state.dueDate !== baseline.dueDate ||
    state.retainage !== baseline.retainage ||
    state.lienWaiver !== baseline.lienWaiver ||
    state.qboExpenseAccountId !== baseline.qboExpenseAccountId ||
    state.qboApAccountId !== baseline.qboApAccountId ||
    state.splitLines.length !== baseline.splitLines.length
  ) {
    return true
  }
  return state.splitLines.some((line, index) => {
    const base = baseline.splitLines[index]
    return (
      line.projectId !== base.projectId ||
      line.costCodeId !== base.costCodeId ||
      line.budgetLineId !== base.budgetLineId ||
      line.description !== base.description ||
      line.amountDollars !== base.amountDollars ||
      line.qboExpenseAccountId !== base.qboExpenseAccountId ||
      line.qboApAccountId !== base.qboApAccountId ||
      line.billableToCustomer !== base.billableToCustomer
    )
  })
}

/**
 * Decimal-string dollars → integer cents without floating-point money math.
 * Returns 0 for empty input, null for anything unparseable.
 */
export function parseDollarsToCents(input: string): number | null {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const match = /^(-?)(\d+)?(?:\.(\d{0,2}))?$/.exec(normalized)
  if (!match || (match[2] === undefined && !match[3])) return null
  const sign = match[1] === "-" ? -1 : 1
  const dollars = match[2] ? Number.parseInt(match[2], 10) : 0
  const cents = Number.parseInt((match[3] ?? "").padEnd(2, "0"), 10)
  return sign * (dollars * 100 + cents)
}

export function sortCostCodes(costCodes: CostCode[]): CostCode[] {
  return [...costCodes].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""))
}
