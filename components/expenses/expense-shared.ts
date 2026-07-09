import { format } from "date-fns"

import { qboTxnUrl } from "@/lib/integrations/accounting/qbo-links"

/** A single cost-allocation split within an expense (mirrors vendor bill_lines). */
export interface ProjectExpenseLine {
  id?: string
  project_id?: string | null
  cost_code_id?: string | null
  cost_code?: { code?: string | null; name?: string | null } | null
  budget_line_id?: string | null
  description?: string | null
  amount_cents: number
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
  sort_order?: number | null
}

/** Single source of truth for the expense shape used by the table and the workspace. */
export interface ProjectExpense {
  id: string
  expense_date: string
  vendor_name_text: string | null
  description: string | null
  status: string
  amount_cents: number | null
  tax_cents: number | null
  is_billable: boolean | null
  receipt_file_id: string | null
  payment_method: string | null
  qbo_id?: string | null
  qbo_sync_status?: "pending" | "synced" | "error" | "skipped" | "needs_review" | null
  qbo_sync_error?: string | null
  qbo_transaction_type?: "purchase" | "bill" | null
  metadata?: Record<string, any> | null
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
  qbo_payment_account_id?: string | null
  qbo_payment_account_name?: string | null
  qbo_ap_account_id?: string | null
  qbo_ap_account_name?: string | null
  qbo_vendor_id?: string | null
  qbo_vendor_name?: string | null
  vendor_company?: { name?: string | null } | null
  cost_code_id?: string | null
  cost_code?: { code?: string | null; name?: string | null } | null
  budget_line_id?: string | null
  lines?: ProjectExpenseLine[]
}

export const AUTO_QBO_VENDOR = "__auto_qbo_vendor__"

export const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  invoiced: "Invoiced",
}

export const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  invoiced: "bg-muted text-muted-foreground border-muted",
}

export function formatCurrency(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function isExpenseCredit(expense: Pick<ProjectExpense, "metadata">) {
  return String(expense.metadata?.source ?? "").startsWith("expense_credit")
}

export function signedExpenseAmountCents(expense: Pick<ProjectExpense, "amount_cents" | "tax_cents" | "metadata">) {
  const amount = (expense.amount_cents ?? 0) + (expense.tax_cents ?? 0)
  return isExpenseCredit(expense) ? -Math.abs(amount) : amount
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  try {
    return format(new Date(`${value}T00:00:00`), "MMM d, yyyy")
  } catch {
    return value
  }
}

export function vendorOf(expense: ProjectExpense) {
  return expense.vendor_company?.name ?? expense.vendor_name_text ?? expense.description ?? "Expense"
}

export function accountLabel(account: { name: string; fullyQualifiedName?: string }) {
  return account.fullyQualifiedName ?? account.name
}

export function costCodeLabel(code: { code?: string | null; name?: string | null }) {
  return `${code.code ?? ""} ${code.name ?? ""}`.trim() || "Cost code"
}

export function hasRequiredQboCoding(expense: ProjectExpense) {
  if (!expense.qbo_expense_account_id) return false
  return Boolean(expense.qbo_payment_account_id)
}

export function needsQboReview(expense: ProjectExpense) {
  if (expense.qbo_sync_status === "needs_review" || expense.qbo_sync_status === "error") return true
  return expense.status === "approved" && expense.qbo_sync_status !== "synced" && !hasRequiredQboCoding(expense)
}

export function readyForQboSync(expense: ProjectExpense) {
  return expense.status === "approved" && expense.qbo_sync_status !== "synced" && !needsQboReview(expense)
}

export function qboDeepLink(expense: ProjectExpense) {
  return qboTxnUrl(expense.qbo_transaction_type === "bill" ? "bill" : "expense", expense.qbo_id)
}
