import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import {
  getUserPermissions,
  requirePermission,
} from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  setPaymentRunApproversSchema,
  type SetPaymentRunApproversInput,
} from "@/lib/validation/fintech-payments"

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
   * `payments.approve_run` — the roster names people, roles grant the power, and
   * the UI has to be able to say when the two have drifted apart.
   */
  permitted: boolean
}

export interface PaymentApprovalRouting {
  /** True when the org has named specific approvers rather than any permitted user. */
  rosterConfigured: boolean
  /** In the org's chosen order — index 0 is who a submitted run is routed to first. */
  approvers: PaymentRunApprover[]
  /** Whether the current user may decide runs at all (before preparer/limit checks). */
  viewerMayApprove: boolean
  /** So a UI can leave the viewer out of "this routes to…" — nobody approves their own run. */
  viewerUserId: string
}

async function loadUserSummaries(userIds: string[]) {
  if (userIds.length === 0)
    return new Map<string, { name: string; email: string | null }>()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("app_users")
    .select("id,full_name,email")
    .in("id", userIds)
  if (error)
    throw new Error(`Unable to load approver profiles: ${error.message}`)
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      {
        name:
          (row.full_name as string | null) ??
          (row.email as string | null) ??
          "Unknown user",
        email: (row.email as string | null) ?? null,
      },
    ]),
  )
}

async function loadRoster(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payment_run_approvers")
    .select("user_id,approval_limit_cents,division_id,sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error)
    throw new Error(`Unable to load payment approvers: ${error.message}`)
  return data ?? []
}

async function hydrateRoster(
  orgId: string,
  rows: Array<{
    user_id: string
    approval_limit_cents: number | string | null
    division_id?: string | null
  }>,
) {
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
      approvalLimitCents:
        row.approval_limit_cents == null
          ? null
          : Number(row.approval_limit_cents),
      divisionId: row.division_id ?? null,
      permitted:
        permissions.includes("*") ||
        permissions.includes("payments.approve_run"),
    }
  })
}

/**
 * Who this org has designated to approve payment runs, and whether the viewer is
 * one of them. An empty roster means the org never narrowed approval beyond the
 * `payments.approve_run` permission, which stays the fallback.
 */
export async function getPaymentApprovalRouting(
  orgId?: string,
): Promise<PaymentApprovalRouting> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const [rows, viewerPermissions] = await Promise.all([
    loadRoster(context.orgId),
    getUserPermissions(context.userId, context.orgId),
  ])
  const viewerHasPermission =
    viewerPermissions.includes("*") ||
    viewerPermissions.includes("payments.approve_run")
  const approvers = await hydrateRoster(context.orgId, rows)
  return {
    rosterConfigured: approvers.length > 0,
    approvers,
    viewerMayApprove:
      viewerHasPermission &&
      (approvers.length === 0 ||
        approvers.some((approver) => approver.userId === context.userId)),
    viewerUserId: context.userId,
  }
}

/** Org members who could be designated — everyone currently holding the permission. */
export async function listPaymentApproverCandidates(
  orgId?: string,
): Promise<Array<{ userId: string; name: string; email: string | null }>> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.manage_rail", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", context.orgId)
    .eq("status", "active")
  if (error) throw new Error(`Unable to load org members: ${error.message}`)
  const userIds = [
    ...new Set(
      (data ?? []).map((row) => row.user_id as string).filter(Boolean),
    ),
  ]
  const [summaries, permissionSets] = await Promise.all([
    loadUserSummaries(userIds),
    Promise.all(
      userIds.map((userId) => getUserPermissions(userId, context.orgId)),
    ),
  ])
  return userIds
    .filter((_, index) => {
      const permissions = permissionSets[index] ?? []
      return (
        permissions.includes("*") ||
        permissions.includes("payments.approve_run")
      )
    })
    .map((userId) => ({
      userId,
      name: summaries.get(userId)?.name ?? "Unknown user",
      email: summaries.get(userId)?.email ?? null,
    }))
}

/**
 * Replace the designated-approver roster. Saving an empty roster is allowed and
 * means "anyone with the permission" — the same fallback new orgs start on. The
 * submitted array order is the routing order and is persisted as `sort_order`.
 */
export async function setPaymentRunApprovers(
  input: SetPaymentRunApproversInput,
  orgId?: string,
) {
  const parsed = setPaymentRunApproversSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.manage_rail", context)
  const supabase = createServiceSupabaseClient()

  const userIds = parsed.approvers.map((approver) => approver.user_id)
  if (userIds.length > 0) {
    const permissionSets = await Promise.all(
      userIds.map((userId) => getUserPermissions(userId, context.orgId)),
    )
    const unpermitted = userIds.filter((_, index) => {
      const permissions = permissionSets[index] ?? []
      return !(
        permissions.includes("*") ||
        permissions.includes("payments.approve_run")
      )
    })
    if (unpermitted.length > 0) {
      throw new Error(
        "Every designated approver needs a role that grants payment-run approval",
      )
    }
  }

  const before = await loadRoster(context.orgId)
  const { error: deleteError } = await supabase
    .from("payment_run_approvers")
    .delete()
    .eq("org_id", context.orgId)
  if (deleteError)
    throw new Error(
      `Unable to update payment approvers: ${deleteError.message}`,
    )
  if (parsed.approvers.length > 0) {
    const { error: insertError } = await supabase
      .from("payment_run_approvers")
      .insert(
        parsed.approvers.map((approver, index) => ({
          org_id: context.orgId,
          user_id: approver.user_id,
          approval_limit_cents: approver.approval_limit_cents ?? null,
          division_id: approver.division_id ?? null,
          sort_order: index,
          created_by: context.userId,
        })),
      )
    if (insertError)
      throw new Error(
        `Unable to update payment approvers: ${insertError.message}`,
      )
  }

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "payment_run_approvers_updated",
      entityType: "payment_rail_policy",
      entityId: context.orgId,
      payload: { approver_count: parsed.approvers.length },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "payment_run_approver_roster",
      entityId: context.orgId,
      before: { approvers: before },
      after: { approvers: parsed.approvers },
    }),
  ])

  return hydrateRoster(
    context.orgId,
    parsed.approvers.map((approver) => ({
      user_id: approver.user_id,
      approval_limit_cents: approver.approval_limit_cents ?? null,
      division_id: approver.division_id ?? null,
    })),
  )
}

/**
 * The designated-approver half of the release gate, called immediately before a
 * decision is committed. Permission alone is not enough once an org has named
 * its approvers, and a named approver cannot exceed their personal ceiling.
 */
export async function assertUserMayApproveRun({
  userId,
  orgId,
  totalDebitCents,
  divisionIds,
}: {
  userId: string
  orgId: string
  totalDebitCents: number
  /** Divisions the run's bills sit in. A run spanning divisions needs org-wide authority. */
  divisionIds?: string[]
}): Promise<void> {
  const rows = await loadRoster(orgId)
  if (rows.length === 0) return
  const entries = rows.filter((row) => row.user_id === userId)
  if (entries.length === 0)
    throw new Error(
      "You are not a designated payment-run approver for this organization",
    )

  // Someone can hold a low org-wide ceiling and a higher one inside their own
  // division, so the question is whether ANY of their entries covers this run,
  // not what their first row says.
  const covering = entries.filter((entry) => {
    if (!entry.division_id) return true
    // A division-scoped approver covers a run only when every bill in it sits
    // in their division. A mixed run needs someone with org-wide authority —
    // approving the part you own is not approving the run.
    const runDivisions = divisionIds ?? []
    return runDivisions.length > 0 && runDivisions.every((division) => division === entry.division_id)
  })
  if (covering.length === 0) {
    throw new Error(
      "This payment run covers work outside the division you approve for; it needs an approver with organization-wide authority",
    )
  }
  const bestLimitCents = covering.reduce<number | null>((best, entry) => {
    const limit = entry.approval_limit_cents == null ? null : Number(entry.approval_limit_cents)
    if (best === null || limit === null) return null
    return Math.max(best, limit)
  }, 0)
  if (bestLimitCents != null && totalDebitCents > bestLimitCents) {
    throw new Error(
      "This payment run exceeds your approval limit; it needs an approver with a higher limit",
    )
  }
}
