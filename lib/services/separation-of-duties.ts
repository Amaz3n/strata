import "server-only"

import {
  billApprovalViolatesSeparation,
  billEnteredByUserId,
  COMMITMENT_SELF_APPROVAL_MESSAGE,
  commitmentApprovalViolatesSeparation,
  SEPARATION_OF_DUTIES_REASON_CODE,
  type SeparationRule,
} from "@/lib/financials/separation-of-duties"
import { logger } from "@/lib/logging/logger"
import { correlationId } from "@/lib/observability/correlation"
import { authorize } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Thrown when a separation rule refuses an approval. Its message is user-facing. */
export class SeparationOfDutiesError extends Error {
  readonly code = "SEPARATION_OF_DUTIES"

  constructor(readonly rule: SeparationRule, message: string) {
    super(message)
    this.name = "SeparationOfDutiesError"
  }
}

interface SeparationDenial {
  resourceId: string
  projectId: string | null
  context?: Record<string, unknown>
}

/**
 * Write refused attempts to `authorization_audit_log`, so a rejected bypass
 * leaves evidence even though nothing else changed. The refusal stands whether
 * or not this write lands; a failed write is reported, never swallowed.
 */
async function recordSeparationDenials(input: {
  orgId: string
  userId: string
  actionKey: string
  resourceType: string
  rule: SeparationRule
  denials: SeparationDenial[]
}) {
  const requestId = await correlationId()
  const { error } = await createServiceSupabaseClient()
    .from("authorization_audit_log")
    .insert(
      input.denials.map((denial) => ({
        actor_user_id: input.userId,
        org_id: input.orgId,
        project_id: denial.projectId,
        action_key: input.actionKey,
        resource_type: input.resourceType,
        resource_id: denial.resourceId,
        decision: "deny",
        reason_code: SEPARATION_OF_DUTIES_REASON_CODE,
        context: { rule: input.rule, ...denial.context },
        request_id: requestId,
      })),
    )
  if (error) {
    logger.error("separation.audit_failed", {
      error: new Error(error.message),
      domain: "authorization",
      orgId: input.orgId,
      rule: input.rule,
    })
  }
}

/** Record the refused attempt, then refuse it. */
export async function refuseSeparationOfDuties(input: {
  orgId: string
  userId: string
  actionKey: string
  resourceType: string
  resourceId: string
  projectId: string | null
  rule: SeparationRule
  message: string
  context?: Record<string, unknown>
}): Promise<never> {
  await recordSeparationDenials({
    orgId: input.orgId,
    userId: input.userId,
    actionKey: input.actionKey,
    resourceType: input.resourceType,
    rule: input.rule,
    denials: [{ resourceId: input.resourceId, projectId: input.projectId, context: input.context }],
  })
  throw new SeparationOfDutiesError(input.rule, input.message)
}

const APPROVER_CHECK_BATCH = 5

/**
 * Whether anyone other than `userId` could exercise `permission` on this project.
 *
 * Holding the key somewhere in the org is not enough: a division- or
 * project-scoped approver who cannot reach the project cannot approve, and
 * counting them would refuse the only person who can. Candidates are the org's
 * other active members whose role or grant names the key; each is then asked
 * the same `authorize()` question the approval itself asks, so denies, division
 * scope and assigned-project scope all apply exactly as they would. Candidates
 * are asked in small concurrent batches, stopping at the first batch with a yes.
 */
export async function anotherApproverCanReach(input: {
  orgId: string
  permission: string
  userId: string
  projectId: string | null
}) {
  const { orgId, permission, userId, projectId } = input
  const service = createServiceSupabaseClient()
  const { data: members, error } = await service
    .from("memberships")
    .select("id, user_id, role_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .neq("user_id", userId)
  if (error) throw new Error(`Unable to verify approvers: ${error.message}`)
  if (!members?.length) return false

  const roleIds = [...new Set(members.map((member) => member.role_id).filter((id): id is string => Boolean(id)))]
  const [roleResult, grantResult] = await Promise.all([
    roleIds.length > 0
      ? service.from("role_permissions").select("role_id").in("role_id", roleIds).in("permission_key", [permission, "*"])
      : Promise.resolve({ data: [], error: null }),
    service
      .from("membership_permission_overrides")
      .select("membership_id")
      .in("membership_id", members.map((member) => member.id))
      .eq("permission_key", permission)
      .eq("effect", "grant"),
  ])
  if (roleResult.error) throw new Error(`Unable to verify approvers: ${roleResult.error.message}`)
  if (grantResult.error) throw new Error(`Unable to verify approvers: ${grantResult.error.message}`)

  const approverRoles = new Set((roleResult.data ?? []).map((row) => row.role_id))
  const grantedMemberships = new Set((grantResult.data ?? []).map((row) => row.membership_id))
  const candidates = [...new Set(
    members
      .filter((member) => approverRoles.has(member.role_id) || grantedMemberships.has(member.id))
      .map((member): string => member.user_id),
  )]

  for (let offset = 0; offset < candidates.length; offset += APPROVER_CHECK_BATCH) {
    const decisions = await Promise.all(
      candidates.slice(offset, offset + APPROVER_CHECK_BATCH).map((candidate) =>
        authorize({ permission, userId: candidate, orgId, projectId: projectId ?? undefined }),
      ),
    )
    if (decisions.some((decision) => decision.allowed)) return true
  }
  return false
}

/**
 * Refuse a person approving a commitment they created while another approver
 * who can reach its project exists. A commitment with no recorded creator
 * (generated, imported, or created before creators were recorded) is never
 * refused, and a one-person shop can still approve its own.
 */
export async function assertCommitmentApprovalSeparated(input: {
  orgId: string
  userId: string
  creatorUserId: string | null
  resourceType: "commitment" | "project"
  resourceId: string
  projectId: string
}) {
  if (input.creatorUserId !== input.userId) return
  const anotherApproverExists = await anotherApproverCanReach({
    orgId: input.orgId,
    permission: "commitment.approve",
    userId: input.userId,
    projectId: input.projectId,
  })
  if (!commitmentApprovalViolatesSeparation({
    creatorUserId: input.creatorUserId,
    approverUserId: input.userId,
    anotherApproverExists,
  })) return
  await refuseSeparationOfDuties({
    orgId: input.orgId,
    userId: input.userId,
    actionKey: "commitment.approve",
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    projectId: input.projectId,
    rule: "commitment.creator_cannot_approve",
    message: COMMITMENT_SELF_APPROVAL_MESSAGE,
    context: { created_by_user_id: input.userId },
  })
}

/**
 * Bills this approver may not approve because they entered them and another
 * approver who can reach the bill's project exists. Every refusal is audited.
 * Returns the refused bill ids; the caller decides whether that fails the whole
 * request or only those rows.
 */
export async function refuseSelfApprovedBills(input: {
  orgId: string
  userId: string
  bills: Array<{ id: string; project_id: string | null; metadata: unknown }>
}): Promise<Set<string>> {
  const enteredByApprover = input.bills.filter((bill) => billEnteredByUserId(bill.metadata) === input.userId)
  if (enteredByApprover.length === 0) return new Set()

  const reachByProject = new Map<string | null, boolean>()
  for (const projectId of new Set(enteredByApprover.map((bill) => bill.project_id))) {
    reachByProject.set(projectId, await anotherApproverCanReach({
      orgId: input.orgId,
      permission: "bill.approve",
      userId: input.userId,
      projectId,
    }))
  }
  const refused = enteredByApprover.filter((bill) =>
    billApprovalViolatesSeparation({
      metadata: bill.metadata,
      approverUserId: input.userId,
      anotherApproverExists: reachByProject.get(bill.project_id) === true,
    }),
  )
  if (refused.length === 0) return new Set()

  await recordSeparationDenials({
    orgId: input.orgId,
    userId: input.userId,
    actionKey: "bill.approve",
    resourceType: "vendor_bill",
    rule: "bill.enterer_cannot_approve",
    denials: refused.map((bill) => ({
      resourceId: bill.id,
      projectId: bill.project_id,
      context: { entered_by_user_id: input.userId },
    })),
  })
  return new Set(refused.map((bill) => bill.id))
}
