import "server-only"
import { z } from "zod"
import { agreementPacketRefusal } from "@/lib/sales/agreement-packet"
import { AgreementQuoteChangedError } from "@/lib/sales/agreement-quote"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const receiptSchema = z.object({
  receipt_id: z.string().uuid(), created: z.boolean(),
  contract: z.object({
    id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(),
    contract_type: z.literal("purchase_agreement"), status: z.string(),
    total_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    snapshot: z.object({ purchase_agreement: z.object({ configuration: z.object({ lot_id: z.string().uuid() }).passthrough(), pricing: z.object({
      quoteHash: z.string().regex(/^[a-f0-9]{64}$/), totalCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).passthrough() }).passthrough() }).passthrough(),
  }).passthrough(),
})
export type AgreementCreationReceipt = z.infer<typeof receiptSchema>

/** A null snapshot probes the immutable receipt without repricing or writing. */
export async function saveAgreementCreation(input: {
  orgId: string; actorId: string; reservationId: string; request: Record<string, unknown>;
  expected?: Record<string, unknown>; snapshot?: Record<string, unknown>;
}): Promise<AgreementCreationReceipt | null> {
  const { data, error } = await createServiceSupabaseClient().rpc("create_purchase_agreement_atomic", {
    p_org_id: input.orgId, p_actor_id: input.actorId, p_reservation_id: input.reservationId,
    p_request: input.request, p_expected: input.expected ?? null, p_snapshot: input.snapshot ?? null,
  })
  if (error?.details === "AGREEMENT_QUOTE_CHANGED") throw new AgreementQuoteChangedError()
  const packetRefusal = agreementPacketRefusal(error)
  if (packetRefusal) throw packetRefusal
  // A refusal raised by the function rolled the whole creation back: nothing was saved to review.
  if (error?.code === "P0001") throw new Error(error.message)
  if (error) throw new Error(`Agreement creation could not be confirmed. Review the saved agreement before retrying: ${error.message}`)
  if (data === null && !input.snapshot) return null
  const parsed = receiptSchema.safeParse(data)
  if (!parsed.success || parsed.data.contract.org_id !== input.orgId
    || parsed.data.contract.snapshot.purchase_agreement.configuration.lot_id !== input.request.lotId
    || (input.expected?.lot && parsed.data.contract.project_id !== (input.expected.lot as Record<string, unknown>).project_id)
    || parsed.data.contract.snapshot.purchase_agreement.pricing.quoteHash !== input.request.expectedQuoteHash
    || parsed.data.contract.total_cents !== parsed.data.contract.snapshot.purchase_agreement.pricing.totalCents) {
    throw new Error("Agreement creation receipt is invalid. Reconcile the saved agreement before retrying.")
  }
  return parsed.data
}

/** Only facts used by sale ownership and configuration acceptance are compared. */
export function agreementCreationExpected(reservation: Record<string, any>, lot: Record<string, any>) {
  return {
    reservation: { id: reservation.id, org_id: reservation.org_id, community_id: reservation.community_id,
      lot_id: reservation.lot_id, status: reservation.status, contract_id: reservation.contract_id,
      buyer_contact_id: reservation.buyer_contact_id, co_buyer_contact_id: reservation.co_buyer_contact_id,
      deposit_invoice_id: reservation.deposit_invoice_id },
    lot: { id: lot.id, org_id: lot.org_id, community_id: lot.community_id, project_id: lot.project_id,
      status: lot.status, premium_cents: lot.premium_cents, house_plan_id: lot.house_plan_id,
      house_plan_version_id: lot.house_plan_version_id, house_plan_elevation_id: lot.house_plan_elevation_id, swing: lot.swing },
  }
}
