import "server-only"

import { billApprovalViolatesSeparation, billEnteredByUserId } from "@/lib/financials/payable-separation"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logger } from "@/lib/logging/logger"

const BILL_SEPARATION_REASON_CODE = "deny_separation_of_duties"

interface SeparationBill {
  id: string
  project_id: string | null
  metadata: unknown
}

async function orgHasAnotherBillApprover(orgId: string, userId: string) {
  const service = createServiceSupabaseClient()
  const { data: roleRows, error: roleError } = await service
    .from("role_permissions")
    .select("role_id")
    .eq("permission_key", "bill.approve")
  if (roleError) throw new Error(`Unable to verify payable approvers: ${roleError.message}`)
  const roleIds = (roleRows ?? []).map((row) => row.role_id).filter(Boolean)
  if (roleIds.length === 0) return false
  const { count, error } = await service
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("role_id", roleIds)
    .neq("user_id", userId)
  if (error) throw new Error(`Unable to verify payable approvers: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * Bills this approver may not approve because they entered them and another
 * approver exists. Every refusal is written to `authorization_audit_log`, so a
 * rejected bypass attempt leaves evidence even though nothing else changed.
 * Returns the refused bill ids; the caller decides whether that fails the whole
 * request or only those rows.
 */
export async function refuseSelfApprovedBills(input: {
  orgId: string
  userId: string
  bills: SeparationBill[]
}): Promise<Set<string>> {
  const enteredByApprover = input.bills.filter((bill) => billEnteredByUserId(bill.metadata) === input.userId)
  if (enteredByApprover.length === 0) return new Set()

  const anotherApproverExists = await orgHasAnotherBillApprover(input.orgId, input.userId)
  const refused = enteredByApprover.filter((bill) =>
    billApprovalViolatesSeparation({ metadata: bill.metadata, approverUserId: input.userId, anotherApproverExists }),
  )
  if (refused.length === 0) return new Set()

  const { error } = await createServiceSupabaseClient()
    .from("authorization_audit_log")
    .insert(
      refused.map((bill) => ({
        actor_user_id: input.userId,
        org_id: input.orgId,
        project_id: bill.project_id,
        action_key: "bill.approve",
        resource_type: "vendor_bill",
        resource_id: bill.id,
        decision: "deny",
        reason_code: BILL_SEPARATION_REASON_CODE,
        context: { rule: "enterer_cannot_approve", entered_by_user_id: input.userId },
      })),
    )
  if (error) logger.error("payables.separation_audit_failed", { error: new Error(error.message), domain: "payables" })

  return new Set(refused.map((bill) => bill.id))
}
