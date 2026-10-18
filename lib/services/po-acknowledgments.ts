import { z } from "zod"
import { readSaleCancellationReview } from "@/lib/services/sale-cancellation-picks"

import { derivePoAckState, describeVersionChanges, poAckVendorSentence, poAckWarning, revisedObligationCents } from "@/lib/purchasing/po-acknowledgment-state"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { requirePermission } from "@/lib/services/permissions"
import { requireAuthorization } from "@/lib/services/authorization"
import { purchasingQueueFiltersSchema, resolvePurchasingQueueReadScope } from "@/lib/services/purchasing-queue-scope"
import { projectPermissionHolders } from "@/lib/services/trade-responses"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { PortalAccessToken } from "@/lib/types"
import {
  poAcknowledgmentInputSchema,
  poAcknowledgmentQueueFiltersSchema,
  poAcknowledgmentQueueReplySchema,
  poIssueSnapshotSchema,
  resolvePoAcknowledgmentSchema,
  type PoAckState,
  type PoAcknowledgmentQueueFilters,
} from "@/lib/validation/po-acknowledgments"

/** How many answered or issued versions one portal page reads per order. */
const PORTAL_VERSION_READ_CAP = 3000

const versionRowSchema = z.object({
  id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  revision: z.number().int(),
  reason: z.string(),
  terms_hash: z.string(),
  created_at: z.string(),
  snapshot: poIssueSnapshotSchema,
})

const answerLineSchema = z.object({
  commitment_line_id: z.string().uuid(),
  kind: z.enum(["quantity", "date", "scope"]),
  proposed_quantity: z.number().nullable(),
  promised_date: z.string().nullable(),
  note: z.string().nullable(),
})

const answerRowSchema = z.object({
  id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  issue_version_id: z.string().uuid(),
  response: z.enum(["accepted", "disputed"]),
  status: z.enum(["open", "resolved"]),
  resolution: z.enum(["upheld", "withdrawn"]).nullable(),
  reason: z.string().nullable(),
  resolution_note: z.string().nullable(),
  responded_at: z.string(),
  lines: z.array(answerLineSchema),
})

export interface PoIssueView {
  versionId: string
  revision: number
  termsHash: string
  issuedAt: string
  state: PoAckState
  /** What the vendor is told about this version, in its own words. */
  sentence: string
  /** Sentences describing what changed since the version the vendor last saw. */
  changes: string[]
  /** The order plus the variance orders approved against it. */
  revisedObligationCents: number
  answer: {
    id: string
    response: "accepted" | "disputed"
    status: "open" | "resolved"
    resolution: "upheld" | "withdrawn" | null
    reason: string | null
    resolutionNote: string | null
    respondedAt: string
    lines: Array<{ commitmentLineId: string; kind: "quantity" | "date" | "scope"; proposedQuantity: number | null; promisedDate: string | null; note: string | null }>
  } | null
}

/**
 * The issued version of each purchase order and the vendor's answer to it, for a
 * list of orders (one vendor's, or one order's). The service client reads: the
 * caller has already decided which orders it may see.
 */
export async function loadPoIssueViews(orgId: string, commitmentIds: string[]): Promise<Map<string, PoIssueView>> {
  const views = new Map<string, PoIssueView>()
  if (!commitmentIds.length) return views
  const supabase = createServiceSupabaseClient()
  const [versionResult, answerResult] = await Promise.all([
    supabase.from("po_issue_versions").select("id,commitment_id,revision,reason,terms_hash,created_at,snapshot")
      .eq("org_id", orgId).in("commitment_id", commitmentIds)
      .order("commitment_id").order("revision", { ascending: false }).limit(PORTAL_VERSION_READ_CAP),
    supabase.from("po_acknowledgments")
      .select("id,commitment_id,issue_version_id,response,status,resolution,reason,resolution_note,responded_at,lines:po_acknowledgment_lines(commitment_line_id,kind,proposed_quantity,promised_date,note)")
      .eq("org_id", orgId).in("commitment_id", commitmentIds).neq("status", "superseded")
      .order("responded_at", { ascending: false }).limit(PORTAL_VERSION_READ_CAP),
  ])
  if (versionResult.error) throw new Error(`Failed to load issued versions: ${versionResult.error.message}`)
  if (answerResult.error) throw new Error(`Failed to load acknowledgments: ${answerResult.error.message}`)
  const versionsByOrder = new Map<string, z.infer<typeof versionRowSchema>[]>()
  for (const row of z.array(versionRowSchema).parse(versionResult.data ?? [])) {
    const list = versionsByOrder.get(row.commitment_id) ?? []
    list.push(row)
    versionsByOrder.set(row.commitment_id, list)
  }
  const answersByOrder = new Map<string, z.infer<typeof answerRowSchema>[]>()
  for (const row of z.array(answerRowSchema).parse(answerResult.data ?? [])) {
    const list = answersByOrder.get(row.commitment_id) ?? []
    list.push(row)
    answersByOrder.set(row.commitment_id, list)
  }

  for (const commitmentId of commitmentIds) {
    const versions = versionsByOrder.get(commitmentId) ?? []
    const latest = versions[0]
    if (!latest) continue
    const answers = answersByOrder.get(commitmentId) ?? []
    const current = answers.find((answer) => answer.issue_version_id === latest.id) ?? null
    const lastAnswered = answers[0] ?? null
    const baseline = lastAnswered ? versions.find((version) => version.id === lastAnswered.issue_version_id) : versions[1]
    const state = derivePoAckState({
      answer: current ? { response: current.response, status: current.status, resolution: current.resolution } : null,
      answeredEarlierVersion: answers.some((answer) => answer.issue_version_id !== latest.id),
      versionIsBackfill: latest.reason === "backfill",
    })
    views.set(commitmentId, {
      versionId: latest.id, revision: latest.revision, termsHash: latest.terms_hash, issuedAt: latest.created_at, state,
      sentence: poAckVendorSentence(state, latest.revision),
      changes: baseline && baseline.id !== latest.id ? describeVersionChanges(baseline.snapshot, latest.snapshot) : [],
      revisedObligationCents: revisedObligationCents(latest.snapshot),
      answer: current ? {
        id: current.id, response: current.response, status: current.status, resolution: current.resolution,
        reason: current.reason, resolutionNote: current.resolution_note, respondedAt: current.responded_at,
        lines: current.lines.map((line) => ({
          commitmentLineId: line.commitment_line_id, kind: line.kind, proposedQuantity: line.proposed_quantity,
          promisedDate: line.promised_date, note: line.note,
        })),
      } : null,
    })
  }
  return views
}

const recordedSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  title: z.string(),
  contract_number: z.string().nullable(),
  revision: z.number().int(),
  created_by: z.string().uuid().nullable(),
})

/**
 * A vendor answers one issued version, from the sub portal. The RPC locks the
 * order and refuses an answer to any version but the current one. A dispute is
 * something purchasing has to act on, so it tells them; an acceptance only shows
 * on the order.
 */
export async function acknowledgePoFromPortal(access: PortalAccessToken, input: unknown, vendorName: string) {
  const parsed = poAcknowledgmentInputSchema.parse(input)
  if (!access.company_id || access.permissions.can_acknowledge_purchase_orders !== true) {
    throw new Error("This portal link does not have permission for that action")
  }
  const supabase = createServiceSupabaseClient()
  if (access.project_id) {
    const { data: order } = await supabase.from("commitments").select("project_id")
      .eq("org_id", access.org_id).eq("id", parsed.commitmentId).maybeSingle()
    if (order?.project_id !== access.project_id) throw new Error("That purchase order is not part of this link")
  }
  const { data, error } = await supabase.rpc("record_po_acknowledgment", {
    p_org_id: access.org_id,
    p_portal_token_id: access.id,
    p_company_id: access.company_id,
    p_commitment_id: parsed.commitmentId,
    p_issue_version_id: parsed.issueVersionId,
    p_terms_hash: parsed.termsHash,
    p_response: parsed.response,
    p_reason: parsed.reason ?? null,
    p_lines: parsed.lines.map((line) => ({
      commitment_line_id: line.commitmentLineId,
      kind: line.kind,
      proposed_quantity: line.kind === "quantity" ? line.proposedQuantity : null,
      promised_date: line.kind === "date" ? line.promisedDate : null,
      note: line.kind === "scope" ? line.note : null,
    })),
  })
  if (error) throw new Error(error.message)
  const recorded = recordedSchema.parse(data)
  if (parsed.response === "accepted") return { id: recorded.id }

  const failed = (reason: string) => recordEvent({
    orgId: access.org_id, eventType: "po_acknowledgment.notification_failed", entityType: "po_acknowledgment", entityId: recorded.id,
    payload: { project_id: recorded.project_id, commitment_id: parsed.commitmentId, reason },
  })
  let recipients: string[]
  try {
    const holders = await projectPermissionHolders(access.org_id, recorded.project_id, "po_exception.resolve")
    recipients = Array.from(new Set(recorded.created_by ? [...holders, recorded.created_by] : holders))
  } catch (error) {
    // The dispute is recorded and waits in the Acknowledgments queue; the failed lookup is on the record rather than lost.
    await failed(error instanceof Error ? error.message : "The resolvers could not be looked up")
    return { id: recorded.id }
  }
  const notifications = new NotificationService()
  const label = recorded.contract_number ?? recorded.title
  const results = await Promise.allSettled(recipients.map((userId) => notifications.createAndQueue({
    orgId: access.org_id, userId, type: "po_acknowledgment_received",
    title: "Vendor disputed a purchase order",
    message: `${vendorName} disputed ${label} (revision ${recorded.revision}): ${parsed.reason}`,
    projectId: recorded.project_id, entityType: "po_acknowledgment", entityId: recorded.id,
    metadata: { href: "/purchasing?tab=acknowledgments" },
  })))
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (rejected.length) await failed(`${rejected.length} of ${results.length} notifications failed: ${String(rejected[0].reason)}`)
  return { id: recorded.id }
}

// ----------------------------------------------------------------------------
// The Purchasing desk queue
// ----------------------------------------------------------------------------

/**
 * Issued purchase orders in the state of their current version, disputed first.
 * Read-mostly: the desk answers by calling `resolvePoAcknowledgment`, and terms
 * change only on the home's purchase order (a VPO, or back to draft).
 */
export async function listPoAcknowledgmentQueue(filters: PoAcknowledgmentQueueFilters = {}, orgId?: string) {
  const parsed = poAcknowledgmentQueueFiltersSchema.parse(filters)
  const page = purchasingQueueFiltersSchema.parse({ page: parsed.page, pageSize: parsed.pageSize })
  const context = await requireOrgContext(orgId)
  await requirePermission("price_book.read", context)
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  const empty = { total: 0, counts: { pending: 0, revised: 0, disputed: 0, accepted: 0 }, rows: [], page: page.page, pageSize: page.pageSize }
  if (scope.divisionIds?.length === 0) return empty
  const { data, error } = await createServiceSupabaseClient().rpc("list_po_acknowledgment_queue", {
    p_org_id: context.orgId,
    p_division_ids: scope.divisionIds,
    p_member_user_id: scope.projectMembershipRequired ? context.userId : null,
    p_community_id: parsed.communityId ?? null,
    p_state: parsed.state,
    p_limit: page.pageSize,
    p_offset: (page.page - 1) * page.pageSize,
  })
  if (error) throw new Error(`Failed to load acknowledgments: ${error.message}`)
  return { ...poAcknowledgmentQueueReplySchema.parse(data), page: page.page, pageSize: page.pageSize }
}

/**
 * Purchasing's answer to a dispute: the terms stand (and the vendor is asked
 * again with the note), or the dispute is closed. A change to the terms is not a
 * resolution; it is a VPO or a re-issue, and it overtakes the dispute by itself.
 */
export async function resolvePoAcknowledgment(input: unknown, orgId?: string) {
  const parsed = resolvePoAcknowledgmentSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("po_exception.resolve", context)
  // Read through the caller's session first: row security carries the division
  // wall that the service-role RPC does not.
  const { data: visible, error: visibleError } = await context.supabase.from("po_acknowledgments")
    .select("id").eq("org_id", context.orgId).eq("id", parsed.acknowledgmentId).maybeSingle()
  if (visibleError) throw new Error(`Failed to load the answer: ${visibleError.message}`)
  if (!visible) throw new Error("Acknowledgment not found")
  const { error } = await createServiceSupabaseClient().rpc("resolve_po_acknowledgment", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_acknowledgment_id: parsed.acknowledgmentId,
    p_resolution: parsed.resolution, p_note: parsed.note,
  })
  if (error) throw new Error(error.message)
}

// ----------------------------------------------------------------------------
// The purchase order workbench
// ----------------------------------------------------------------------------

export interface PoIssuance {
  /** Null while the order is a draft or was never versioned. */
  current: (PoIssueView & { warning: string | null }) | null
  history: Array<{ revision: number; reason: string; issuedAt: string }>
  /** A cancelled sale's picks still on the order: open until purchasing keeps or cancels them. */
  picksReview: { status: "open" | "resolving" | "kept" | "cancelled"; lineCount: number; totalCents: number } | null
}

/** What was issued on one purchase order and how the vendor answered, for its workbench. */
export async function getPoIssuance(commitmentId: string, orgId?: string): Promise<PoIssuance> {
  const context = await requireOrgContext(orgId)
  const id = z.string().uuid().parse(commitmentId)
  // A purchasing manager reads orders across houses without being on a team, so the
  // order is read by the service scoped to the org; the authorization below carries
  // the project and division scope.
  const { data: order, error } = await createServiceSupabaseClient().from("commitments").select("id,project_id,metadata")
    .eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (error) throw new Error(`Failed to load the purchase order: ${error.message}`)
  if (!order) throw new Error("Purchase order not found")
  await requireAuthorization({
    permission: "commitment.read", userId: context.userId, orgId: context.orgId, projectId: order.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "commitment", resourceId: id,
  })
  const [views, history] = await Promise.all([
    loadPoIssueViews(context.orgId, [commitmentId]),
    createServiceSupabaseClient().from("po_issue_versions").select("revision,reason,created_at")
      .eq("org_id", context.orgId).eq("commitment_id", commitmentId).order("revision", { ascending: false }).limit(20),
  ])
  if (history.error) throw new Error(`Failed to load issued versions: ${history.error.message}`)
  const view = views.get(commitmentId)
  const review = readSaleCancellationReview(order.metadata)
  return {
    current: view ? { ...view, warning: poAckWarning(view.state) } : null,
    history: (history.data ?? []).map((row) => ({ revision: Number(row.revision), reason: String(row.reason), issuedAt: String(row.created_at) })),
    picksReview: review ? { status: review.status, lineCount: review.lines.length, totalCents: review.lines.reduce((sum, line) => sum + line.amount_cents, 0) } : null,
  }
}
