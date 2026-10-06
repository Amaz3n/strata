import { createHash } from "node:crypto"
import { createESignEvidenceManifest } from "@/lib/esign/evidence"

export function createEstimateEvidenceManifest(input: {
  documentId: string; envelopeId: string; revision: number; sourceHash: string; executedHash: string
  builder: Record<string, any>; earlierClient: Record<string, any>
}, privateKeyPem = process.env.ESIGN_EVIDENCE_PRIVATE_KEY_PEM) {
  const builder = input.builder
  const client = input.earlierClient
  const text = (value: unknown) => typeof value === "string" ? value : null
  return createESignEvidenceManifest({
    document_id: input.documentId, envelope_id: input.envelopeId, revision: input.revision,
    source_sha256: input.sourceHash, executed_sha256: input.executedHash,
    signatures: [{ evidence_source: "recorded_native_builder_signature",
      signature_id: text(builder.signature_id), name: text(builder.signer_name), email: text(builder.signer_email),
      signed_at: text(builder.signed_at), ip_address: text(builder.signer_ip), user_agent: text(builder.user_agent),
      consent: text(builder.consent_text), consent_version: text(builder.consent_version),
      signature_image_sha256: typeof builder.signature_image === "string" ? createHash("sha256").update(builder.signature_image).digest("hex") : null,
    }],
    earlier_client_metadata: { evidence_source: "earlier_client_metadata",
      name: text(client.signer_name), email: text(client.signer_email), signed_at: text(client.signed_at),
      ip_address: text(client.signer_ip), consent: text(client.consent_text),
      consent_version: text(client.consent_version),
      signature_image_sha256: typeof client.signature_image === "string" ? createHash("sha256").update(client.signature_image).digest("hex") : null,
      consent_accepted: typeof client.consent_accepted === "boolean" ? client.consent_accepted : null,
      source: text(client.source),
    },
  }, privateKeyPem)
}
