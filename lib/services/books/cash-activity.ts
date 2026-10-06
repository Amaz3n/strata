import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { cashProfitAndLossFromSnapshot } from "@/lib/services/books/cash-profit-loss"
import { cashInvoiceIncomeFromSnapshot } from "@/lib/services/books/cash-income-snapshot"
import { cashBillCostsFromSnapshot } from "@/lib/services/books/cash-cost-snapshot"
import { cashDirectExpensesFromSnapshot } from "@/lib/services/books/cash-expense-snapshot"
import { cashSettlementAncillaryFromSnapshot } from "@/lib/services/books/cash-settlement-ancillary"

/** Supporting activity shares one database revision; full cash P&L policies remain. */
export async function buildCashAccountingActivity(startDate: string, endDate: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "cash_accounting_activity", resourceId: context.orgId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (error) throw new Error(`Failed to capture cash accounting activity: ${error.message}`)
  return {
    statement: "cash_accounting_activity" as const, startDate, endDate,
    invoiceIncome: cashInvoiceIncomeFromSnapshot(context.orgId, startDate, endDate, data),
    billCosts: cashBillCostsFromSnapshot(context.orgId, startDate, endDate, data),
    directExpenses: cashDirectExpensesFromSnapshot(context.orgId, startDate, endDate, data),
    settlementAncillary: cashSettlementAncillaryFromSnapshot(context.orgId, startDate, endDate, data),
  }
}

/** Cash P&L is a distinct report from the operating-cash reconciliation. */
export async function buildCashProfitAndLoss(startDate: string, endDate: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "cash_profit_loss", resourceId: context.orgId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (error) throw new Error(`Failed to capture cash P&L: ${error.message}`)
  return cashProfitAndLossFromSnapshot(context.orgId, startDate, endDate, data)
}
