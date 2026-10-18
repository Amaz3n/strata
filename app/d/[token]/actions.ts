"use server"

import { assertWaiverRecipientEmail, requiresWaiverCompanyMember, waiverRecipientConsent } from "@/lib/invoices/waiver-recipient"

import { createHmac } from "crypto"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { generateExecutedPdf } from "@/lib/pdfs/esign"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { submitEstimateBuilderSignatureBySigningToken } from "@/lib/services/estimate-portal"
import { getFilesStorageProvider } from "@/lib/storage/files-storage"
import { resolveSigningRequestToken } from "@/lib/esign/signing-tokens"
import { requireSigningAccess, unlockSigningAccess } from "@/lib/esign/access-code"
import { parseSignerFieldValues } from "@/lib/esign/field-values"
import { ELECTRONIC_SIGNATURE_CONSENT_TEXT, ESIGN_CONSENT_VERSION } from "@/lib/esign/consent"
import { finalizeDocumentSigning, ensureFrozenSigningSource, loadFrozenSigningBytes } from "@/lib/services/esign-execution"

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }
  return secret
}

function buildExecutedDocumentUrl(token: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return appUrl ? `${appUrl}/api/esign/executed/${token}` : `/api/esign/executed/${token}`
}

export async function submitDocumentSignatureAction(input: {
  token: string
  signerName: string
  signerEmail?: string | null
  values: Record<string, any>
  consentText: string
}) {
  if (!input.token) {
    throw new Error("Missing signing token")
  }

  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(input.token).digest("hex")

  const { data: signingRequest, error } = await resolveSigningRequestToken(supabase, input.token)

  if (error || !signingRequest) {
    throw new Error(`Signing request not found: ${error?.message ?? "Invalid link"}`)
  }

  await requireSigningAccess(signingRequest)
  const now = new Date()
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
    throw new Error("Signing link has expired")
  }
  if (signingRequest.status === "voided" || signingRequest.status === "expired") {
    throw new Error("Signing request is no longer valid")
  }
  if (signingRequest.status !== "signed" && signingRequest.used_count >= signingRequest.max_uses) {
    throw new Error("Signing link has already been used")
  }

  if (signingRequest.status === "signed") {
    const { data: receiptDocument, error: receiptError } = await supabase.from("documents").select("status")
      .eq("org_id", signingRequest.org_id).eq("id", signingRequest.document_id).single()
    if (receiptError || !receiptDocument) throw new Error("Signing document not found")
    if (["voided", "expired"].includes(receiptDocument.status)) throw new Error("Signing request is no longer valid")
    if (signingRequest.envelope_id) {
      const { data: envelope, error: envelopeError } = await supabase.from("envelopes").select("status,expires_at")
        .eq("org_id", signingRequest.org_id).eq("id", signingRequest.envelope_id).single()
      if (envelopeError || !envelope || ["voided", "expired"].includes(envelope.status) ||
          (envelope.expires_at && new Date(envelope.expires_at) < now)) throw new Error("Signing request is no longer valid")
    }
    return acceptedSignatureReceipt(signingRequest, input.token)
  }

  if (typeof input.signerName !== "string" || !input.signerName.trim() || input.signerName.length > 256) {
    throw new Error("Signer name is required")
  }
  if (typeof input.signerEmail !== "string" || input.signerEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.signerEmail.trim())) {
    throw new Error("Signer email is required")
  }
  if (typeof input.consentText !== "string" || !input.consentText.trim()) {
    throw new Error("Consent text is required")
  }

  const submittedSignerEmail = input.signerEmail!.trim()

  const envelopeId = signingRequest.envelope_id ?? signingRequest.group_id ?? signingRequest.id
  const sequence = signingRequest.sequence ?? 1
  const signerRole = signingRequest.signer_role ?? "client"

  let priorSignersQuery = supabase
    .from("document_signing_requests")
    .select("id, status, sequence, required")
    .lt("sequence", sequence)
    .order("sequence", { ascending: true })

  if (signingRequest.envelope_id) {
    priorSignersQuery = priorSignersQuery.eq("envelope_id", signingRequest.envelope_id)
  } else {
    priorSignersQuery = priorSignersQuery.eq("group_id", signingRequest.group_id ?? signingRequest.id)
  }

  const { data: priorSigners, error: priorError } = await priorSignersQuery

  if (priorError) {
    throw new Error(`Failed to validate signing order: ${priorError.message}`)
  }

  const pendingPrior = (priorSigners ?? []).filter((req) => req.required !== false && req.status !== "signed")
  if (pendingPrior.length > 0) {
    throw new Error("This signer is not yet authorized to sign")
  }

  if (getFilesStorageProvider() !== "r2") {
    throw new Error("E-sign documents must be stored in R2. Set FILES_STORAGE=r2.")
  }

  const forwardedFor = (await headers()).get("x-forwarded-for")
  const signerIp = forwardedFor?.split(",")?.[0]?.trim() ?? null
  const userAgent = (await headers()).get("user-agent") ?? null

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, org_id, project_id, prospect_id, title, document_type, source_file_id, source_entity_type, source_entity_id, created_by, metadata")
    .eq("id", signingRequest.document_id)
    .single()

  if (documentError || !document) {
    throw new Error(`Document not found: ${documentError?.message ?? "missing"}`)
  }

  const { data: fields, error: fieldsError } = await supabase
    .from("document_fields")
    .select("id, page_index, field_type, required, signer_role, x, y, w, h, metadata")
    .eq("document_id", document.id)
    .eq("revision", signingRequest.revision)
    .order("sort_order", { ascending: true })

  if (fieldsError) {
    throw new Error(`Failed to load document fields: ${fieldsError.message}`)
  }

  if (document.metadata?.waiver_signing_experience === "review") {
    assertWaiverRecipientEmail(signingRequest.sent_to_email, submittedSignerEmail)
  }
  if (document.metadata?.waiver_signing_experience === "review" && requiresWaiverCompanyMember(signerRole)) {
    const { listWaiverSigners } = await import("@/lib/services/waiver-signers")
    const member = (await listWaiverSigners(supabase, signingRequest.org_id)).find(person => person.id === document.metadata?.waiver_signer_id)
    if (!member || member.email.toLowerCase() !== submittedSignerEmail.toLowerCase() || member.email.toLowerCase() !== String(signingRequest.sent_to_email).toLowerCase()) {
      throw new Error("This signature request is assigned to a different or inactive company member")
    }
  }

  const canonicalConsent = document.metadata?.waiver_signing_experience === "review"
    ? waiverRecipientConsent(signerRole) : ELECTRONIC_SIGNATURE_CONSENT_TEXT
  // The internal waiver self-sign flow uses the shared general disclosure.
  if (input.consentText !== canonicalConsent && !(document.metadata?.invoice_lien_waiver_id && input.consentText === ELECTRONIC_SIGNATURE_CONSENT_TEXT)) {
    throw new Error("Please review and accept the current electronic signature consent")
  }
  const consentText = input.consentText === ELECTRONIC_SIGNATURE_CONSENT_TEXT ? ELECTRONIC_SIGNATURE_CONSENT_TEXT : canonicalConsent
  const values = await parseSignerFieldValues({ fields: fields ?? [], signerRole, values: input.values })
  const source = await ensureFrozenSigningSource(document.org_id, document.id)
  const sourceBytes = await loadFrozenSigningBytes(document.org_id, source)
  await generateExecutedPdf({ pdfBytes: sourceBytes, fields: fields ?? [], values,
    auditTrail: [{ label: "Signer", value: input.signerName.trim() }, { label: "Email", value: submittedSignerEmail }, { label: "Consent", value: consentText }] })

  const nowIso = now.toISOString()
  const auditData = {
    consent_version: ESIGN_CONSENT_VERSION,
    consent_accepted_at: nowIso,
    signed_at: nowIso,
    signer_role: signerRole,
    signer_email_on_request: signingRequest.sent_to_email ?? null,
    submitted_signer_email: submittedSignerEmail,
    identity_mismatch:
      !!signingRequest.sent_to_email &&
      signingRequest.sent_to_email.trim().toLowerCase() !== submittedSignerEmail.toLowerCase(),
    ip_address: signerIp,
    user_agent: userAgent,
    token_hash_prefix: tokenHash.slice(0, 16),
    document_id: signingRequest.document_id,
    document_revision: signingRequest.revision,
    envelope_id: envelopeId,
    source_file_id: source.file_id,
    source_sha256: source.sha256,
  }

  const { error: recordSignatureError } = await supabase.rpc("record_document_signature_atomic", {
    p_org_id: signingRequest.org_id,
    p_signing_request_id: signingRequest.id,
    p_document_id: signingRequest.document_id,
    p_revision: signingRequest.revision,
    p_signer_name: input.signerName.trim(),
    p_signer_email: submittedSignerEmail,
    p_signer_ip: signerIp,
    p_user_agent: userAgent,
    p_consent_text: consentText,
    p_values: values,
    p_audit_data: auditData,
    p_signed_at: nowIso,
  })

  if (recordSignatureError) {
    throw new Error(`Failed to record signature: ${recordSignatureError.message}`)
  }

  return acceptedSignatureReceipt(signingRequest, input.token)
}

async function acceptedSignatureReceipt(signingRequest: { org_id: string; id: string; document_id: string }, token: string) {
  const supabase = createServiceSupabaseClient()
  let executedDocumentUrl: string | null = null
  // Acceptance is committed with an outbox job. Inline execution only improves latency;
  // its failure never asks a signer to sign again or loses the retry.
  try {
    await finalizeDocumentSigning(signingRequest.org_id, signingRequest.id)
  } catch (error) {
    console.error("Accepted signature awaits durable finalization", { requestId: signingRequest.id, error })
  }
  const { data: completed } = await supabase.from("documents").select("executed_file_id")
    .eq("org_id", signingRequest.org_id).eq("id", signingRequest.document_id).single()
  if (completed?.executed_file_id) executedDocumentUrl = buildExecutedDocumentUrl(createExecutedFileAccessToken(completed.executed_file_id))

  revalidatePath(`/d/${token}`)
  return { success: true, executedDocumentUrl }
}

export async function declineDocumentSignatureAction(input: { token: string; reason?: string | null }) {
  if (!input.token) throw new Error("Missing signing token")

  const supabase = createServiceSupabaseClient()
  const { data: signingRequest, error } = await resolveSigningRequestToken(supabase, input.token)

  if (error || !signingRequest) {
    throw new Error(`Signing request not found: ${error?.message ?? "Invalid link"}`)
  }
  await requireSigningAccess(signingRequest)
  if (signingRequest.status === "signed") throw new Error("This request has already been signed")
  if (signingRequest.status === "voided" || signingRequest.status === "expired") {
    throw new Error("This signing request is no longer active")
  }
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < new Date()) {
    throw new Error("Signing link has expired")
  }

  const envelopeId = signingRequest.envelope_id ?? signingRequest.group_id ?? signingRequest.id
  const reason = input.reason?.trim() || null
  const { error: declineError } = await supabase.rpc("cancel_esign_envelope", {
    p_org_id: signingRequest.org_id, p_envelope_id: envelopeId, p_reason: reason,
    p_request_id: signingRequest.id, p_actor_id: null,
  })
  if (declineError) throw new Error(declineError.message)

  revalidatePath(`/d/${input.token}`)
  return { success: true }
}

export async function submitEstimateBuilderSignatureAction(input: {
  token: string
  signerName: string
  signerEmail?: string | null
  signatureText?: string | null
  signatureImage?: string | null
  consentText: string
}) {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  const signerIp = forwarded?.split(",")?.[0]?.trim() ?? h.get("x-real-ip")
  const result = await submitEstimateBuilderSignatureBySigningToken({ ...input, signerIp })
  revalidatePath(`/d/${input.token}`)
  return result
}

export async function unlockDocumentSigningAction(input: { token: string; code: string }) {
  try {
    const { data: request, error } = await resolveSigningRequestToken(createServiceSupabaseClient(), input.token)
    if (error || !request) throw new Error("Invalid signing link")
    await unlockSigningAccess(request, input.code)
    return { success: true }
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : "Unable to unlock document" } }
}
