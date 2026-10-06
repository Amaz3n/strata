import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ensureFrozenSigningSource } from "@/lib/services/esign-execution"

import { agreementSigningInput, type SigningContract } from "@/lib/sales/agreement-signing-source"
export { agreementSigningInput } from "@/lib/sales/agreement-signing-source"

const ownedDocumentSchema = z.object({ id: z.string().uuid(), source_file_id: z.string().uuid() })
export type OwnedAgreementDocument = z.infer<typeof ownedDocumentSchema>

/** Probe before rendering; the same transaction reserves the winner after upload. */
export async function reserveAgreementSigningDocument(input: {
  orgId: string; actorId: string; contract: SigningContract; fileId?: string; recipients?: unknown;
}): Promise<OwnedAgreementDocument | null> {
  const { data, error } = await createServiceSupabaseClient().rpc("reserve_purchase_agreement_document", {
    p_org_id: input.orgId, p_contract_id: input.contract.id, p_actor_id: input.actorId,
    p_expected: agreementSigningInput(input.contract), p_file_id: input.fileId ?? null, p_recipients: input.recipients ?? null,
  })
  if (error) throw new Error(`Agreement signing ownership could not be confirmed: ${error.message}`)
  if (data === null && !input.fileId) return null
  const parsed = ownedDocumentSchema.safeParse(data)
  if (!parsed.success) throw new Error("Agreement signing ownership reply is invalid. Reconcile the saved document before retrying.")
  return parsed.data
}

/** Publication rechecks ownership, actor/home scope, bound recipients and source. */
export async function publishOwnedAgreementDocument(input: { orgId: string; actorId: string; document: OwnedAgreementDocument }) {
  const source = await ensureFrozenSigningSource(input.orgId, input.document.id)
  const { data, error } = await createServiceSupabaseClient().rpc("publish_purchase_agreement_document", {
    p_org_id: input.orgId, p_document_id: input.document.id, p_actor_id: input.actorId, p_source: source,
  })
  const envelope = z.string().uuid().safeParse(data)
  if (error || !envelope.success) throw new Error(`The agreement was saved but signing publication could not be confirmed. Reconcile its document before retrying: ${error?.message ?? "Invalid envelope receipt"}`)
  return { documentId: input.document.id, envelopeId: envelope.data, reason: "The signing packet is prepared. Buyer invitations are queued for delivery." }
}
