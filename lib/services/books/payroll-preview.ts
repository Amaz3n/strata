import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { payrollImportSchema } from "./payroll-import-rules"
import { payrollReconciliationFromSnapshot } from "./payroll-labor-snapshot"

/** Server-owned labor evidence; no caller-supplied wage basis or journal IDs.
 * This does not verify provider bytes, approve a run or post its journal.
 */
export async function previewPayrollReconciliation(input: unknown) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "payroll_import", resourceId: context.orgId, logDecision: true })
  const run = payrollImportSchema.parse(input)
  if (run.org_id !== context.orgId) throw new Error("Payroll import organization mismatch")
  const { data, error } = await createServiceSupabaseClient().rpc("capture_books_export_snapshot", { p_org_id: context.orgId })
  if (error) throw new Error(`Failed to capture payroll accounting evidence: ${error.message}`)
  return payrollReconciliationFromSnapshot(context.orgId, run, data)
}
