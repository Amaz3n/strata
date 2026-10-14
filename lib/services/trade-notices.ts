import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getProjectReadScopeForUser } from "@/lib/services/authorization"
import { triggerStartsPipeline } from "@/lib/services/starts-pipeline-trigger"
import { noticeContentHash } from "@/lib/starts/lookahead-rules"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  reserveReplySchema, tradeNoticeAttentionSchema, tradeNoticeDeliverySchema, tradeNoticeResolutionSchema,
  type TradeNoticeAttention, type TradeNoticeSnapshot,
} from "@/lib/validation/trade-notices"

const ATTENTION_LIMIT = 50

export type TradeNoticeKind = "lookahead" | "release" | "schedule_change"
export type TradeNoticeOutcome = "sent" | "duplicate" | "skipped"

export interface TradeNoticeDraft {
  snapshot: TradeNoticeSnapshot
  subject: string
  recipients: string[]
}

/**
 * The link a trade's email opens: the person's token for this house when the
 * notice is about one house, else their vendor-account token. A paused, expired
 * or revoked token is not a link; with none, the email carries no button.
 */
export async function resolveTradePortalLink(supabase: SupabaseClient, orgId: string, companyId: string, projectId: string | null) {
  const { data, error } = await supabase.from("portal_access_tokens").select("token,project_id,created_at")
    .eq("org_id", orgId).eq("company_id", companyId).eq("portal_type", "sub")
    .is("revoked_at", null).is("paused_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(50)
  if (error) throw new Error(`Failed to load trade portal access: ${error.message}`)
  const usable = data ?? []
  const forHouse = projectId ? usable.find((token) => token.project_id === projectId) : undefined
  const token = forHouse ?? usable.find((candidate) => candidate.project_id === null)
  if (!token) return null
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  return `${appUrl}/s/${token.token}`
}

function render(snapshot: TradeNoticeSnapshot) {
  const cell = "padding:6px;border-bottom:1px solid #ddd"
  const lines = snapshot.lines.map((line) => `<tr><td style="${cell}">${escapeHtml(line.label)}</td><td style="${cell}">${escapeHtml(line.name)}</td><td style="${cell}">${escapeHtml(line.dates)}</td></tr>`).join("")
  return renderStandardEmailLayout({
    title: snapshot.title,
    messageHtml: `<p>${escapeHtml(snapshot.intro)}</p><table style="width:100%;border-collapse:collapse">${lines}</table>`,
    buttonText: snapshot.buttonText ?? undefined, buttonUrl: snapshot.buttonUrl ?? undefined,
    orgName: snapshot.org.name, orgLogoUrl: snapshot.org.logoUrl, showManageSettings: false,
  })
}

/**
 * Send one notice exactly once. The notice is reserved with its content before
 * anything is sent, and the email goes out from that reserved content under the
 * delivery's own provider key, so:
 *  - a retry after a crash sends the same words to the same people, and the
 *    provider hands back the first message instead of sending a second;
 *  - a notice that was already accepted is a duplicate, whoever asks;
 *  - a notice reserved so long ago that the provider's key has lapsed is
 *    ambiguous and waits for a coordinator rather than guessing.
 * `build` runs only when no delivery exists for the key, and returns null when
 * there is nothing to say (nothing is reserved then). The caller has already
 * authorized the send.
 */
export async function deliverTradeNotice(input: {
  orgId: string
  actorId: string | null
  kind: TradeNoticeKind
  companyId: string
  projectId: string | null
  outboxId?: number
  dedupeKey: string
  scope: Record<string, unknown>
  build: () => Promise<TradeNoticeDraft | null>
}): Promise<TradeNoticeOutcome> {
  const service = createServiceSupabaseClient()
  const { data: existingRow, error: existingError } = await service.from("trade_notice_deliveries")
    .select("id,org_id,kind,company_id,project_id,snapshot,recipients,subject,idempotency_key,status,last_error,content_hash")
    .eq("org_id", input.orgId).eq("dedupe_key", input.dedupeKey).maybeSingle()
  if (existingError) throw new Error(`Failed to inspect trade notice delivery: ${existingError.message}`)
  if (existingRow?.status === "accepted") return "duplicate"

  let draft: TradeNoticeDraft | null
  let contentHash: string
  if (existingRow) {
    const stored = tradeNoticeDeliverySchema.parse(existingRow)
    draft = { snapshot: stored.snapshot, subject: stored.subject, recipients: stored.recipients }
    contentHash = String(existingRow.content_hash)
  } else {
    draft = await input.build()
    if (!draft) return "skipped"
    contentHash = noticeContentHash(draft)
  }

  const { data: reserved, error: reserveError } = await service.rpc("reserve_trade_notice", {
    p_org_id: input.orgId, p_kind: input.kind, p_company_id: input.companyId, p_project_id: input.projectId,
    p_outbox_id: input.outboxId ?? null, p_dedupe_key: input.dedupeKey, p_scope: input.scope,
    p_snapshot: draft.snapshot, p_recipients: draft.recipients, p_subject: draft.subject,
    p_content_hash: contentHash, p_actor_id: input.actorId,
  })
  if (reserveError) throw new Error(`Failed to reserve trade notice: ${reserveError.message}`)
  const { send, delivery } = reserveReplySchema.parse(reserved)
  if (!send) {
    if (delivery.status === "accepted") return "duplicate"
    throw new Error("The outcome of this trade notice is unknown; resolve it on the Starts desk before sending it again")
  }

  const settle = async (outcome: "accepted" | "failed", messageId: string | null, failure: string | null) => {
    const { error } = await service.rpc("settle_trade_notice", {
      p_org_id: input.orgId, p_id: delivery.id, p_outcome: outcome, p_message_id: messageId, p_error: failure,
    })
    if (error) throw new Error(`Failed to record trade notice delivery: ${error.message}`)
  }
  let providerMessageId: string | null = null
  let settleFailure: unknown = null
  const accepted = await sendEmail({
    to: delivery.recipients, subject: delivery.subject, html: render(delivery.snapshot),
    from: getOrgSenderEmail(delivery.snapshot.org.slug ?? undefined, delivery.snapshot.org.name ?? undefined),
    idempotencyKey: delivery.idempotency_key,
    onAccepted: async (messageId) => {
      providerMessageId = messageId
      try { await settle("accepted", messageId, null) } catch (error) { settleFailure = error; throw error }
    },
  })
  if (accepted) return "sent"
  // The provider took it but the record did not land: the row stays reserved,
  // and the retry re-sends under the same key and records the first message.
  if (providerMessageId !== null) throw settleFailure instanceof Error ? settleFailure : new Error("Failed to record trade notice delivery")
  await settle("failed", null, "The email was not accepted; correct delivery settings or recipients and retry")
  throw new Error("The trade notice email was not accepted; retry after correcting delivery settings or recipients")
}

/** Every failed or unresolved notice in the caller's scope, for the Trades desk. */
export async function listTradeNoticeAttention(orgId?: string): Promise<{ total: number; rows: TradeNoticeAttention[]; limit: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const access = await getProjectReadScopeForUser(context)
  if (access.divisionIds !== null && !access.divisionIds.length) return { total: 0, rows: [], limit: ATTENTION_LIMIT }
  const { data, error } = await createServiceSupabaseClient().rpc("list_trade_notice_attention", {
    p_org_id: context.orgId, p_division_ids: access.divisionIds,
    p_member_user_id: access.projectMembershipRequired ? context.userId : null, p_limit: ATTENTION_LIMIT,
  })
  if (error) throw new Error(`Failed to load trade notices needing attention: ${error.message}`)
  const reply = tradeNoticeAttentionSchema.parse(data)
  return { ...reply, limit: ATTENTION_LIMIT }
}

/**
 * A coordinator's answer for a notice whose outcome is unknown: it arrived, or
 * send it again under a new provider key. The row is read through the caller's
 * own session first, so the division wall decides whether it is theirs to resolve.
 */
export async function resolveTradeNotice(input: unknown, orgId?: string) {
  const parsed = tradeNoticeResolutionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requirePermission("start.write", context)
  const { data: visible, error: visibleError } = await context.supabase.from("trade_notice_deliveries").select("id")
    .eq("org_id", context.orgId).eq("id", parsed.deliveryId).maybeSingle()
  if (visibleError) throw new Error(`Failed to load trade notice delivery: ${visibleError.message}`)
  if (!visible) throw new Error("Trade notice delivery not found")
  const { error } = await createServiceSupabaseClient().rpc("resolve_trade_notice", {
    p_org_id: context.orgId, p_id: parsed.deliveryId, p_actor_id: context.userId, p_resolution: parsed.resolution, p_note: parsed.note,
  })
  if (error) throw new Error(`Unable to resolve trade notice: ${error.message}`)
  if (parsed.resolution === "resend") void triggerStartsPipeline()
}
