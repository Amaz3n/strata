import "server-only"

import { getUserPermissions } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The designated-approver roster, with no viewer.
 *
 * It lives here rather than in `payment-approvers.ts` because the notification
 * fan-out needs it too, and `payment-approvers.ts` raises events — importing it
 * from `events.ts` would close a cycle. Every read is service-role: the caller is
 * either an authorized service function or the fan-out, which has no session at
 * all.
 */

export interface PaymentRunApprover {
  userId: string
  name: string
  email: string | null
  /** Personal ceiling on the run debit total this approver may decide. */
  approvalLimitCents: number | null
  /**
   * Division this approver is restricted to, or null for org-wide. A ceiling
   * alone cannot express "approves anything in Westside" — it would have handed
   * that person authority over every division at the same amount.
   */
  divisionId: string | null
  /**
   * False when the person is still on the roster but no longer holds
   * `payment.approve_run` — the roster names people, roles grant the power, and
   * the UI has to be able to say when the two have drifted apart.
   */
  permitted: boolean
}

export interface PaymentApproverRosterRow {
  user_id: string
  approval_limit_cents: number | string | null
  division_id?: string | null
}

/** Display names and addresses for a set of users, in one read. */
export async function loadUserSummaries(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, { name: string; email: string | null }>()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("app_users").select("id,full_name,email").in("id", userIds)
  if (error) throw new Error(`Unable to load approver profiles: ${error.message}`)
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        name: (row.full_name as string | null) ?? (row.email as string | null) ?? "Unknown user",
        email: (row.email as string | null) ?? null,
      },
    ]),
  )
}

export async function loadApproverRosterRows(orgId: string): Promise<PaymentApproverRosterRow[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payment_run_approvers")
    .select("user_id,approval_limit_cents,division_id,sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) throw new Error(`Unable to load payment approvers: ${error.message}`)
  return (data ?? []) as PaymentApproverRosterRow[]
}

export async function hydrateApproverRoster(
  orgId: string,
  rows: PaymentApproverRosterRow[],
): Promise<PaymentRunApprover[]> {
  const userIds = rows.map((row) => row.user_id)
  const [summaries, permissionSets] = await Promise.all([
    loadUserSummaries(userIds),
    Promise.all(userIds.map((userId) => getUserPermissions(userId, orgId))),
  ])
  return rows.map((row, index) => {
    const summary = summaries.get(row.user_id)
    const permissions = permissionSets[index] ?? []
    return {
      userId: row.user_id,
      name: summary?.name ?? "Unknown user",
      email: summary?.email ?? null,
      approvalLimitCents: row.approval_limit_cents == null ? null : Number(row.approval_limit_cents),
      divisionId: row.division_id ?? null,
      permitted: permissions.includes("*") || permissions.includes("payment.approve_run"),
    }
  })
}

/** The org's designated approvers, hydrated. Empty when the org named nobody. */
export async function loadPaymentApproverRoster(orgId: string): Promise<PaymentRunApprover[]> {
  return hydrateApproverRoster(orgId, await loadApproverRosterRows(orgId))
}
