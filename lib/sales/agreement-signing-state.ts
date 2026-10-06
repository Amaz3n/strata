export type AgreementSigningStage = "not_prepared" | "prepared" | "queued" | "awaiting_buyer" | "awaiting_builder" | "completed" | "delivery_failed" | "reconcile" | "unavailable"
export interface AgreementSigningState {
  stage: AgreementSigningStage
  title: string
  detail: string
  documentId: string | null
  canResume: boolean
}
export interface SigningRequestFact {
  id: string; status: string; sequence: number; required: boolean; signerRole: string
  contactId: string | null; deliveryStatus: string | null; providerId: string | null
}
const labels: Record<AgreementSigningStage, [string, string]> = {
  not_prepared: ["Agreement saved; signing not prepared", "The saved agreement has no signing document yet."],
  prepared: ["Signing preparation incomplete", "A signing document exists, but buyer invitations have not been queued."],
  queued: ["Buyer invitations queued", "Email acceptance has not yet been confirmed for every pending buyer."],
  awaiting_buyer: ["Awaiting buyer signatures", "Buyer signatures are still pending. Review invitation delivery in the signing document."],
  awaiting_builder: ["Awaiting builder signature", "Buyer signatures are complete. The builder must countersign."],
  completed: ["Agreement signatures complete", "The signing envelope has executed."],
  delivery_failed: ["Signing delivery needs attention", "A pending signer invitation failed, bounced, or was reported as spam. Review the recipient and delivery evidence."],
  reconcile: ["Signing packet needs reconciliation", "The agreement and signing records do not identify one complete, consistent packet."],
  unavailable: ["Signing status unavailable", "Signing evidence could not be loaded. Reload before taking action."],
}
export function signingState(stage: AgreementSigningStage, documentId: string | null = null, canResume = false): AgreementSigningState {
  const [title,detail] = labels[stage]
  return { stage,title,detail,documentId,canResume }
}

export type AgreementReconciliationIssue = "source" | "configuration" | "reservation"
const reconciliationDetails: Record<AgreementReconciliationIssue, string> = {
  source: "The saved agreement differs from the source frozen in its signing document. Compare both records before preparing another packet.",
  configuration: "The saved agreement configuration no longer matches a sellable lot on this home. Review the agreement and lot configuration before preparing signatures.",
  reservation: "The agreement does not own exactly one active reservation for its saved lot. Review reservation ownership before preparing signatures.",
}
export function agreementReconciliationState(issue: AgreementReconciliationIssue, documentId: string | null = null): AgreementSigningState {
  return { ...signingState("reconcile", documentId), detail: reconciliationDetails[issue] }
}
/** Status is evidence, never inferred from a draft contract or a prepared link. */
export function deriveAgreementSigningState(input: {
  documentId: string; documentStatus: string; envelopeStatus: string | null; owned: boolean;
  buyerId: string; coBuyerId: string | null; requests: SigningRequestFact[]; canManage: boolean;
}): AgreementSigningState {
  const state = (stage: AgreementSigningStage) => signingState(stage,input.documentId,stage === "prepared" && input.owned && input.canManage)
  if (input.envelopeStatus === null && input.documentStatus === "draft" && input.requests.length === 0) return state("prepared")
  const expected = [{ role: "buyer",contact: input.buyerId,sequence:1 },...(input.coBuyerId ? [{role:"co_buyer",contact:input.coBuyerId,sequence:1}] : []),{role:"builder",contact:null,sequence:2}]
  if (input.requests.length !== expected.length || new Set(input.requests.map(r=>r.id)).size !== expected.length || expected.some(e=>{
    const matching = input.requests.filter(r=>r.signerRole===e.role)
    return matching.length!==1 || matching[0].contactId!==e.contact || matching[0].sequence!==e.sequence || !matching[0].required
  })) return state("reconcile")
  if (input.documentStatus === "signed" && input.envelopeStatus === "executed" && input.requests.every(r=>r.status === "signed")) return state("completed")
  if (input.documentStatus === "draft" && input.envelopeStatus === "draft" && input.requests.every(r=>r.status === "draft")) return state("prepared")
  if (input.documentStatus !== "sent" || !["sent","partially_signed"].includes(input.envelopeStatus ?? "") || input.requests.some(r=>!["draft","sent","viewed","signed"].includes(r.status))) return state("reconcile")
  const pending = input.requests.filter(r=>r.status !== "signed")
  if (pending.length === 0) return state("reconcile") // Execution has not persisted.
  if (pending.some(r=>["failed","bounced","complained"].includes(r.deliveryStatus ?? ""))) return state("delivery_failed")
  const buyers = pending.filter(r=>r.signerRole !== "builder")
  if (buyers.length === 0) return state("awaiting_builder")
  if (buyers.some(r=>r.status === "draft") || input.requests.some(r=>r.signerRole === "builder" && r.status !== "draft")) return state("reconcile")
  return state(buyers.every(r=>r.status === "viewed" || Boolean(r.providerId && ["accepted","sent","delivered"].includes(r.deliveryStatus ?? ""))) ? "awaiting_buyer" : "queued")
}
