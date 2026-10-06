import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { cashBillCostsFromSnapshot } from "@/lib/services/books/cash-cost-snapshot"

/** Supporting paid purchases; complete cash P&L policies and other costs are separate. */
export async function buildCashBillCosts(startDate: string, endDate: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "cash_bill_costs", resourceId: context.orgId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (error) throw new Error(`Failed to capture paid-cost accounting evidence: ${error.message}`)
  return cashBillCostsFromSnapshot(context.orgId, startDate, endDate, data)
}
