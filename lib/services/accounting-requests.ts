import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionScopedProjectIds, requireAuthorization } from "@/lib/services/authorization"
import { enqueueAccountingPush, type AccountingPushEntityType } from "@/lib/services/accounting-sync"
import { recordAudit } from "@/lib/services/audit"

/** Every human request enters the same authorized durable delivery path. */
export async function requestAccountingPush(input: { entityType: AccountingPushEntityType; entityId: string; projectId?: string }) {
  const parsed = z.object({ entityType: z.enum(["invoice", "payment", "project_expense", "vendor_bill", "bill_payment"]), entityId: z.string().uuid(), projectId: z.string().uuid().optional() }).parse(input)
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const table = parsed.entityType === "invoice" ? "invoices" : parsed.entityType === "vendor_bill" ? "vendor_bills" : parsed.entityType === "project_expense" ? "project_expenses" : "payments"
  const { data, error } = await context.supabase.from(table).select("project_id").eq("org_id", context.orgId).eq("id", parsed.entityId).maybeSingle()
  if (error || !data) throw new Error("Accounting transaction not found within your authorized scope")
  if (parsed.projectId && parsed.projectId !== data.project_id) throw new Error("Accounting transaction does not belong to this project")
  if (data.project_id) await requireAuthorization({ permission: "accounting.entity_map.manage", orgId: context.orgId, userId: context.userId, projectId: data.project_id, supabase: context.supabase, logDecision: true })
  else if (await getDivisionScopedProjectIds(context) !== null) throw new Error("Organization-wide transaction requires access to all divisions")
  const result = await enqueueAccountingPush({ orgId: context.orgId, entityType: parsed.entityType, entityId: parsed.entityId })
  if (!result.queued) throw new Error(`Accounting sync was not queued: ${result.reason}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: parsed.entityType, entityId: parsed.entityId, source: "accounting_manual_sync", after: { queued: true, record_id: result.recordId } })
  return result
}
