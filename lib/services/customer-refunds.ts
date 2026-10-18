import "server-only"

import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const refundSchema = z.object({
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(1, "Enter a refund reason").max(500),
  idempotencyKey: z.string().uuid(),
})

/** Records an offline refund; provider-managed money is refunded at the provider. */
export async function recordCustomerRefund(input: unknown) {
  const parsed = refundSchema.parse(input)
  const context = await requireOrgContext()
  const { data: payment, error } = await context.supabase.from("payments")
    .select("id,invoice_id,project_id,provider")
    .eq("org_id", context.orgId).eq("id", parsed.paymentId).maybeSingle()
  if (error || !payment?.invoice_id) throw new Error("Payment not found")
  const decision = await requireAuthorization({ permission: "payment.release", userId: context.userId, orgId: context.orgId, projectId: payment.project_id ?? undefined, supabase: context.supabase, resourceType: "payment", resourceId: payment.id, logDecision: true })
  if (!payment.project_id && decision.divisionScope === "assigned") throw new Error("Organization-wide payment access is required for general billing")
  if (payment.provider !== "manual") throw new Error("Refund this payment through its payment provider")
  const service = createServiceSupabaseClient()
  const { data, error: refundError } = await service.rpc("record_manual_customer_refund_atomic", {
    p_org_id: context.orgId, p_payment_id: payment.id, p_amount_cents: parsed.amountCents,
    p_reason: parsed.reason, p_idempotency_key: parsed.idempotencyKey, p_actor_id: context.userId,
  })
  if (refundError || !data) throw new Error(`Could not record refund: ${refundError?.message ?? "No refund returned"}`)
  if (!data.duplicate) {
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "payment_reversal", entityId: data.id, after: data, source: "receivables.customer_refund" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_reversed", entityType: "payment", entityId: payment.id, payload: { amount_cents: parsed.amountCents, reversal_type: "refund", project_id: payment.project_id ?? null } })
  }
  return { invoiceId: payment.invoice_id as string, projectId: payment.project_id as string | null }
}
