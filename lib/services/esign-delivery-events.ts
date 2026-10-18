import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const deliveryStatuses: Record<string, string> = {
  "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delayed",
  "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed",
}

export async function recordSigningEmailAccepted(input: { orgId: string; requestId: string; providerId: string; expectedTokenHash: string; kind: "invitation" | "reminder" }) {
  const { error } = await createServiceSupabaseClient().rpc("record_esign_email_accepted", {
    p_org_id: input.orgId, p_request_id: input.requestId, p_provider_id: input.providerId, p_kind: input.kind, p_expected_token_hash: input.expectedTokenHash,
  })
  if (error) throw new Error(`Could not record signing email acceptance: ${error.message}`)
}

/** Only call after authenticating the provider's webhook signature. */
export async function processSigningDeliveryWebhook(input: { eventId: string; type?: string; createdAt?: unknown; data?: Record<string, unknown> }) {
  const status = deliveryStatuses[input.type ?? ""]
  if (!status) return false
  const providerId = input.data?.email_id
  if (!input.eventId || typeof providerId !== "string" || !providerId) throw new Error("Delivery event is missing its identifier")
  const occurredAt = typeof input.createdAt === "string" ? new Date(input.createdAt) : null
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) throw new Error("Delivery event is missing its timestamp")
  const errorText = status === "bounced" ? "Recipient email bounced. Verify the address before resending."
    : status === "complained" ? "Recipient reported this email as spam."
    : status === "failed" ? "Email provider could not deliver this message."
    : status === "delayed" ? "Email provider is retrying delivery." : null
  const { error } = await createServiceSupabaseClient().rpc("record_esign_delivery_event", {
    p_event_id: input.eventId, p_provider_id: providerId, p_status: status,
    p_occurred_at: occurredAt.toISOString(), p_error: errorText,
  })
  if (error) throw new Error(`Could not record signing delivery event: ${error.message}`)
  return true
}
