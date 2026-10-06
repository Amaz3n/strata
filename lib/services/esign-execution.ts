import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, uploadFilesObject, buildOrgScopedPath } from "@/lib/storage/files-storage"
import { createESignEvidenceManifest } from "@/lib/esign/evidence"
import { generateExecutedPdf } from "@/lib/pdfs/esign"

export type FrozenSigningSource = { file_id: string; storage_path: string; sha256: string; size_bytes: number }
export const signingDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Copy the bytes, not a mutable files-row pointer. The database freezes this manifest at send. */
export async function freezeSigningSource(orgId: string, documentId: string, sourceFileId: string): Promise<FrozenSigningSource> {
  const db = createServiceSupabaseClient()
  const { data: file, error } = await db.from("files").select("storage_path").eq("org_id", orgId).eq("id", sourceFileId).single()
  if (error || !file) throw new Error("Source document not found")
  const bytes = await downloadFilesObject({ supabase: db, orgId, path: file.storage_path })
  const sha256 = signingDigest(bytes)
  // Validate PDF structure before anyone is invited.
  await generateExecutedPdf({ pdfBytes: bytes, fields: [], values: {} })
  const path = buildOrgScopedPath(orgId, "esign", documentId, "source", `${randomUUID()}.pdf`)
  await uploadFilesObject({ supabase: db, orgId, path, bytes: Buffer.from(bytes), contentType: "application/pdf", upsert: false })
  return { file_id: sourceFileId, storage_path: path, sha256, size_bytes: bytes.length }
}

export async function loadFrozenSigningBytes(orgId: string, source: FrozenSigningSource) {
  const db = createServiceSupabaseClient()
  const bytes = await downloadFilesObject({ supabase: db, orgId, path: source.storage_path })
  if (signingDigest(bytes) !== source.sha256) throw new Error("The signing source failed its integrity check")
  return bytes
}

/** Establish a legacy snapshot before display, never retroactively for an accepted signature. */
export async function ensureFrozenSigningSource(orgId: string, documentId: string): Promise<FrozenSigningSource> {
  const db = createServiceSupabaseClient()
  const { data: document, error } = await db.from("documents").select("source_file_id,metadata,status")
    .eq("org_id", orgId).eq("id", documentId).single()
  if (error || !document) throw new Error("Signing document not found")
  if (document.metadata?.esign_source) return document.metadata.esign_source as FrozenSigningSource
  const source = await freezeSigningSource(orgId, documentId, document.source_file_id)
  // The RPC locks the document and rechecks existing signatures and the source
  // pointer. Concurrent first viewers all receive the same winning snapshot.
  const { data, error: freezeError } = await db.rpc("freeze_legacy_esign_source", {
    p_org_id: orgId, p_document_id: documentId, p_source_file_id: document.source_file_id, p_source: source,
  })
  if (freezeError || !data) throw new Error(freezeError?.message ?? "Unable to freeze signing source")
  return data as FrozenSigningSource
}

/** The same durable job may run inline, after an outage, or more than once. */
export async function finalizeDocumentSigning(orgId: string, requestId: string) {
  const db = createServiceSupabaseClient()
  const { data: request, error: requestError } = await db.from("document_signing_requests").select("*").eq("org_id", orgId).eq("id", requestId).single()
  if (requestError || !request) throw new Error("Signing request not found")
  const envelopeId = request.envelope_id ?? request.group_id ?? request.id
  const { data: accepted, error: acceptedError } = await db.from("document_signatures").select("audit_data").eq("signing_request_id", requestId).eq("org_id", orgId).maybeSingle()
  if (acceptedError) throw new Error(acceptedError.message)
  if (accepted?.audit_data?.source === "estimate_native_builder_signing") {
    const { finalizeEstimateBuilderSignature } = await import("@/lib/services/estimate-portal")
    await finalizeEstimateBuilderSignature({ orgId, requestId })
    return
  }
  const leaseToken = randomUUID()
  const { data: execution, error: claimError } = await db.rpc("claim_esign_execution", { p_org_id: orgId, p_envelope_id: envelopeId, p_lease_token: leaseToken })
  if (claimError) throw new Error(claimError.message)
  if (!execution) {
    // Stage advancement was queued atomically with acceptance. Try its delivery
    // now as well; the provider key and durable job make retries safe.
    let pending = db.from("document_signing_requests").select("id").eq("org_id", orgId)
      .in("status", ["sent", "viewed"])
    pending = request.envelope_id ? pending.eq("envelope_id", request.envelope_id)
      : request.group_id ? pending.eq("group_id", request.group_id) : pending.eq("id", request.id)
    const { data: nextRequests, error: pendingError } = await pending
    if (pendingError) throw new Error("Unable to read pending signing invitations")
    const { deliverSigningInvitation } = await import("@/lib/services/signature-delivery")
    await Promise.all((nextRequests ?? []).map(next => deliverSigningInvitation({ orgId, requestId: next.id })))
    return
  }
  try {
    const { data: document, error } = await db.from("documents").select("*").eq("org_id", orgId).eq("id", request.document_id).single()
    if (error || !document) throw new Error("Signing document not found")
    const source = document.metadata?.esign_source as FrozenSigningSource | undefined
    if (!source) throw new Error("Signing document has no frozen source; sender recovery is required")
    let relatedRequests = db.from("document_signing_requests").select("id,signer_role")
      .eq("org_id", orgId).eq("document_id", document.id).eq("revision", request.revision)
    relatedRequests = request.envelope_id ? relatedRequests.eq("envelope_id", request.envelope_id)
      : request.group_id ? relatedRequests.eq("group_id", request.group_id) : relatedRequests.eq("id", request.id)
    const [fieldResult, requestResult] = await Promise.all([
      db.from("document_fields").select("*").eq("org_id", orgId).eq("document_id", document.id).eq("revision", request.revision).order("sort_order"),
      relatedRequests,
    ])
    if (fieldResult.error || requestResult.error) throw new Error("Unable to read signing assignments")
    const requests = requestResult.data ?? []
    const { data: signatures, error: signatureError } = await db.from("document_signatures").select("*").eq("org_id", orgId).in("signing_request_id", requests.map(r => r.id)).order("created_at")
    if (signatureError || !signatures?.length) throw new Error("Signature evidence missing")
    const fields = fieldResult.data ?? []
    const values: Record<string, string | boolean> = {}
    // Ownership is rechecked when executing, including historical signature rows.
    for (const signature of signatures) {
      const owner = requests.find(r => r.id === signature.signing_request_id)
      for (const field of fields.filter(f => f.signer_role === owner?.signer_role)) {
        const value = signature.values?.[field.id]
        if (typeof value === "string" || typeof value === "boolean") values[field.id] = value
      }
    }
    const bytes = await loadFrozenSigningBytes(orgId, source)
    const auditTrail = [
      { label: "Document ID", value: document.id }, { label: "Envelope ID", value: envelopeId },
      { label: "Document revision", value: String(request.revision) }, { label: "Source SHA-256", value: source.sha256 },
      ...signatures.flatMap((signature, index) => [
        { label: `Signer ${index + 1}`, value: signature.signer_name }, { label: "Email", value: signature.signer_email },
        { label: "Signed at", value: signature.created_at }, { label: "IP address", value: signature.signer_ip },
        { label: "Consent", value: signature.consent_text }, { label: "Consent version", value: signature.audit_data?.consent_version },
      ]),
    ]
    const executed = await generateExecutedPdf({ pdfBytes: bytes, fields, values, auditTrail })
    const path = buildOrgScopedPath(orgId, "esign", document.id, "executed", `${execution.file_id}-${leaseToken}.pdf`)
    const name = `${document.title.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 80) || "document"}_executed.pdf`
    await uploadFilesObject({ supabase: db, orgId, path, bytes: Buffer.from(executed), contentType: "application/pdf", upsert: false })
    const lastSigner = signatures[signatures.length - 1]
    const metadata = { evidence_manifest: createESignEvidenceManifest({ document_id:document.id, envelope_id:envelopeId, revision:request.revision, source_sha256:source.sha256, executed_sha256:signingDigest(executed), signatures:signatures.map(signature => ({ name:signature.signer_name ?? null, email:signature.signer_email ?? null, signed_at:signature.created_at, consent:signature.consent_text })) }), source_file_id: source.file_id, source_sha256: source.sha256, executed_sha256: signingDigest(executed), envelope_id: envelopeId, audit_certificate: "appended_to_executed_pdf" }
    const { error: finishError } = await db.rpc("complete_esign_execution", {
      p_org_id: orgId, p_envelope_id: envelopeId, p_lease_token: leaseToken,
      p_artifact: { file_name: name, storage_path: path, size_bytes: executed.length, metadata,
        signer: { signer_name: lastSigner.signer_name, signer_email: lastSigner.signer_email, signer_ip: lastSigner.signer_ip } },
    })
    if (finishError) throw new Error(finishError.message)
  } catch (error) {
    // Release only our own lease; the durable outbox keeps the failed attempt.
    await db.from("esign_executions").update({ status: "pending", lease_until: null }).eq("org_id", orgId).eq("envelope_id", envelopeId).eq("lease_token", leaseToken).neq("status", "completed")
    throw error
  }
}
