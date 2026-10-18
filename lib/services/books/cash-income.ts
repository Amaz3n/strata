import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { cashInvoiceIncomeFromSnapshot } from "@/lib/services/books/cash-income-snapshot"

/** Supporting income statement; expenses and reviewed tax adjustments remain separate. */
export async function buildCashInvoiceIncome(startDate: string, endDate: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "cash_invoice_income", resourceId: context.orgId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (error) throw new Error(`Failed to capture cash-income accounting evidence: ${error.message}`)
  return cashInvoiceIncomeFromSnapshot(context.orgId, startDate, endDate, data)
}
