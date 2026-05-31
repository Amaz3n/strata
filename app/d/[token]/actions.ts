"use server"

import { createHash, createHmac, randomBytes } from "crypto"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import { ENVELOPE_EVENT_TYPES, buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { generateExecutedPdf } from "@/lib/pdfs/esign"
import { SignatureEmail } from "@/lib/emails/signature-email"
import { recordESignEvent } from "@/lib/services/esign-events"
import { recordEvent } from "@/lib/services/events"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { acceptProposalFromEnvelopeExecution } from "@/lib/services/proposals"
import { approveChangeOrderFromEnvelopeExecution } from "@/lib/services/change-orders"
import { confirmSelectionFromEnvelopeExecution } from "@/lib/services/selections"
import {
  executeEstimateFromEnvelopeExecution,
  submitEstimateBuilderSignatureBySigningToken,
} from "@/lib/services/estimate-portal"
import {
  buildOrgScopedPath,
  downloadFilesObject,
  getFilesStorageProvider,
  uploadFilesObject,
} from "@/lib/storage/files-storage"

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

function sha256Hex(bytes: Uint8Array | Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}

type SigningRequestRoutingRow = {
  id: string
  sequence?: number | null
  required?: boolean | null
  status?: string | null
  sent_to_email?: string | null
}

function getNextRequiredSequence(requests: SigningRequestRoutingRow[]) {
  const ordered = [...requests].sort((a, b) => (a.sequence ?? 1) - (b.sequence ?? 1))
  const next = ordered.find(
    (request) =>
      request.required !== false &&
      request.status !== "signed" &&
      request.status !== "voided" &&
      request.status !== "expired",
  )

  if (!next) return null
  const nextSequence = next.sequence ?? 1
  return ordered.filter(
    (request) =>
      (request.sequence ?? 1) === nextSequence &&
      request.required !== false &&
      request.status !== "signed" &&
      request.status !== "voided" &&
      request.status !== "expired",
  )
}

async function issueSigningLinkForRequest(
  supabase: any,
  params: { orgId: string; requestId: string },
) {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
  const nowIso = new Date().toISOString()

  const { error } = await supabase
    .from("document_signing_requests")
    .update({
      token_hash: tokenHash,
      status: "sent",
      sent_at: nowIso,
    })
    .eq("org_id", params.orgId)
    .eq("id", params.requestId)

  if (error) {
    throw new Error(`Failed to issue next signing link: ${error.message}`)
  }

  return buildUnifiedSigningUrl(token)
}

export async function submitDocumentSignatureAction(input: {
  token: string
  signerName: string
  signerEmail?: string | null
  values: Record<string, any>
  consentText: string
}) {
  let executedDocumentUrl: string | null = null

  if (!input.token) {
    throw new Error("Missing signing token")
  }
  if (!input.signerName?.trim()) {
    throw new Error("Signer name is required")
  }
  if (!input.signerEmail?.trim()) {
    throw new Error("Signer email is required")
  }
  if (!input.consentText?.trim()) {
    throw new Error("Consent text is required")
  }

  const supabase = createServiceSupabaseClient()
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(input.token).digest("hex")

  const { data: signingRequest, error } = await supabase
    .from("document_signing_requests")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error || !signingRequest) {
    throw new Error(`Signing request not found: ${error?.message ?? "Invalid link"}`)
  }

  const now = new Date()
  const submittedSignerEmail = input.signerEmail.trim()
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
    throw new Error("Signing link has expired")
  }
  if (signingRequest.status === "voided" || signingRequest.status === "expired") {
    throw new Error("Signing request is no longer valid")
  }
  if (signingRequest.used_count >= signingRequest.max_uses) {
    throw new Error("Signing link has already been used")
  }

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

  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", signingRequest.org_id)
    .maybeSingle()

  const { data: fields, error: fieldsError } = await supabase
    .from("document_fields")
    .select("id, page_index, field_type, required, signer_role, x, y, w, h")
    .eq("document_id", document.id)
    .eq("revision", signingRequest.revision)
    .order("sort_order", { ascending: true })

  if (fieldsError) {
    throw new Error(`Failed to load document fields: ${fieldsError.message}`)
  }

  const visibleFields = (fields ?? []).filter((field) => !field.signer_role || field.signer_role === signerRole)
  const requiredFields = visibleFields.filter((field) => field.required !== false)
  const isFieldComplete = (field: any) => {
    const value = input.values?.[field.id]
    if (field.field_type === "checkbox") return value === true
    if (field.field_type === "signature") return typeof value === "string" && value.length > 0
    return typeof value === "string" && value.trim().length > 0
  }
  const missingRequired = requiredFields.filter((field) => !isFieldComplete(field))
  if (missingRequired.length > 0) {
    throw new Error("Please complete all required fields")
  }

  const { data: sourceFile, error: sourceError } = await supabase
    .from("files")
    .select("id, storage_path, file_name, mime_type, size_bytes")
    .eq("id", document.source_file_id)
    .single()

  if (sourceError || !sourceFile) {
    throw new Error(`Source file missing: ${sourceError?.message ?? "missing"}`)
  }

  const { error: insertError } = await supabase.from("document_signatures").insert({
    org_id: signingRequest.org_id,
    signing_request_id: signingRequest.id,
    document_id: signingRequest.document_id,
    revision: signingRequest.revision,
    signer_name: input.signerName.trim(),
    signer_email: submittedSignerEmail,
    signer_ip: signerIp,
    user_agent: userAgent,
    consent_text: input.consentText,
    values: input.values ?? {},
    audit_data: {
      consent_version: "esign-consent-2026-05-24",
      consent_presented_at: now.toISOString(),
      signed_at: now.toISOString(),
      signer_role: signerRole,
      signer_email_on_request: signingRequest.sent_to_email ?? null,
      submitted_signer_email: submittedSignerEmail,
      ip_address: signerIp,
      user_agent: userAgent,
      token_hash_prefix: tokenHash.slice(0, 16),
      document_id: signingRequest.document_id,
      document_revision: signingRequest.revision,
      envelope_id: envelopeId,
      source_file_id: sourceFile.id,
    },
  })

  if (insertError) {
    throw new Error(`Failed to record signature: ${insertError.message}`)
  }

  const nowIso = now.toISOString()
  const { error: updateError } = await supabase
    .from("document_signing_requests")
    .update({
      status: "signed",
      signed_at: nowIso,
      used_count: (signingRequest.used_count ?? 0) + 1,
    })
    .eq("id", signingRequest.id)

  if (updateError) {
    throw new Error(`Failed to update signing request: ${updateError.message}`)
  }

  await recordESignEvent({
    supabase,
    orgId: signingRequest.org_id,
    eventType: ENVELOPE_EVENT_TYPES.recipientSigned,
    envelopeId,
    documentId: signingRequest.document_id,
    payload: {
      signing_request_id: signingRequest.id,
      sequence: sequence,
      signer_role: signerRole,
      signer_name: input.signerName.trim(),
      signer_email_on_request: signingRequest.sent_to_email ?? null,
      submitted_signer_email: submittedSignerEmail,
      signer_ip: signerIp,
      user_agent: userAgent,
      consent_text: input.consentText,
      consent_version: "esign-consent-2026-05-24",
      signed_at: nowIso,
    },
  })

  await recordEvent({
    orgId: signingRequest.org_id,
    eventType: ENVELOPE_EVENT_TYPES.recipientSigned,
    entityType: "document",
    entityId: signingRequest.document_id,
    payload: {
      project_id: document.project_id,
      title: `${input.signerName.trim()} signed ${document.title}`,
      signing_request_id: signingRequest.id,
      signer_role: signerRole,
      signed_at: nowIso,
    },
  })

  let remainingQuery = supabase
    .from("document_signing_requests")
    .select("id, status, required, sequence, sent_to_email")
    .eq("org_id", signingRequest.org_id)

  if (signingRequest.envelope_id) {
    remainingQuery = remainingQuery.eq("envelope_id", signingRequest.envelope_id)
  } else {
    remainingQuery = remainingQuery.eq("group_id", signingRequest.group_id ?? signingRequest.id)
  }

  const { data: remaining, error: remainingError } = await remainingQuery

  if (remainingError) {
    throw new Error(`Failed to check signing completion: ${remainingError.message}`)
  }

  const allRequiredSigned = (remaining ?? []).every(
    (req) => req.required === false || req.status === "signed",
  )
  const requiredSignedCount = (remaining ?? []).filter(
    (req) => req.required !== false && req.status === "signed",
  ).length
  const requiredPendingCount = (remaining ?? []).filter(
    (req) =>
      req.required !== false &&
      req.status !== "signed" &&
      req.status !== "voided" &&
      req.status !== "expired",
  ).length

  if (allRequiredSigned) {
    let groupRequestsQuery = supabase
      .from("document_signing_requests")
      .select("id")

    if (signingRequest.envelope_id) {
      groupRequestsQuery = groupRequestsQuery.eq("envelope_id", signingRequest.envelope_id)
    } else {
      groupRequestsQuery = groupRequestsQuery.eq("group_id", signingRequest.group_id ?? signingRequest.id)
    }

    const { data: groupRequests, error: groupRequestsError } = await groupRequestsQuery

    if (groupRequestsError) {
      throw new Error(`Failed to load signing group requests: ${groupRequestsError.message}`)
    }

    const requestIds = (groupRequests ?? []).map((req) => req.id)
    const { data: signatures, error: signaturesError } = await supabase
      .from("document_signatures")
      .select("values, signing_request_id, signer_name, signer_email, signer_ip, user_agent, consent_text, created_at")
      .in("signing_request_id", requestIds)
      .order("created_at", { ascending: true })

    if (signaturesError) {
      throw new Error(`Failed to load signatures: ${signaturesError.message}`)
    }

    const mergedValues = (signatures ?? []).reduce<Record<string, any>>((acc, sig: any) => {
      return { ...acc, ...(sig.values ?? {}) }
    }, {})

    const sourceBytes = await downloadFilesObject({
      supabase,
      orgId: document.org_id,
      path: sourceFile.storage_path,
    })
    const sourceSha256 = sha256Hex(sourceBytes)
    const signerAuditTrail = (signatures ?? []).flatMap((signature: any, index: number) => [
      { label: `Signer ${index + 1} name`, value: signature.signer_name },
      { label: `Signer ${index + 1} email`, value: signature.signer_email },
      { label: `Signer ${index + 1} signed at`, value: signature.created_at },
      { label: `Signer ${index + 1} IP`, value: signature.signer_ip },
      { label: `Signer ${index + 1} user agent`, value: signature.user_agent },
      { label: `Signer ${index + 1} consent`, value: signature.consent_text },
    ])
    const auditTrail = [
      { label: "Document ID", value: document.id },
      { label: "Envelope ID", value: envelopeId },
      { label: "Document revision", value: String(signingRequest.revision) },
      { label: "Source file ID", value: sourceFile.id },
      { label: "Source SHA-256", value: sourceSha256 },
      { label: "Executed at", value: nowIso },
      { label: "Consent version", value: "esign-consent-2026-05-24" },
      ...signerAuditTrail,
    ]

    const executedBytes = await generateExecutedPdf({
      pdfBytes: sourceBytes,
      fields: (fields ?? []).map((field) => ({
        id: field.id,
        page_index: field.page_index,
        field_type: field.field_type,
        x: field.x,
        y: field.y,
        w: field.w,
        h: field.h,
      })),
      values: mergedValues,
      auditTrail,
    })
    const executedSha256 = sha256Hex(executedBytes)

    const timestamp = Date.now()
    const safeTitle = document.title.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 80)
    const executedName = `${safeTitle || "document"}_executed.pdf`
    const projectId = (document.project_id as string | null) ?? null
    const prospectId = (document.prospect_id as string | null) ?? null
    const storageContextType = projectId ? "projects" : prospectId ? "prospects" : "documents"
    const storageContextId = projectId ?? prospectId ?? document.id
    const executedPath = buildOrgScopedPath(
      document.org_id,
      storageContextType,
      storageContextId,
      "esign",
      document.id,
      "executed",
      `${timestamp}_${executedName}`,
    )

    await uploadFilesObject({
      supabase,
      orgId: document.org_id,
      path: executedPath,
      bytes: executedBytes,
      contentType: "application/pdf",
      upsert: false,
    })

    const uploaderId = signingRequest.created_by ?? document.created_by ?? null

    const { data: executedFile, error: executedFileError } = await supabase
      .from("files")
      .insert({
        org_id: document.org_id,
        project_id: projectId,
        prospect_id: prospectId,
        file_name: executedName,
        storage_path: executedPath,
        mime_type: "application/pdf",
        size_bytes: executedBytes.length,
        visibility: "private",
        category: "contracts",
        folder_path: projectId ? `/projects/${projectId}/esign/executed` : `/prospects/${storageContextId}/esign/executed`,
        source: "generated",
        uploaded_by: uploaderId,
        share_with_clients: false,
        share_with_subs: false,
        metadata: {
          source_file_id: sourceFile.id,
          source_sha256: sourceSha256,
          executed_sha256: executedSha256,
          audit_certificate: "appended_to_executed_pdf",
          consent_version: "esign-consent-2026-05-24",
        },
      })
      .select("id")
      .single()

    if (executedFileError || !executedFile) {
      throw new Error(`Failed to create executed file record: ${executedFileError?.message}`)
    }

    const { data: version, error: versionError } = await supabase
      .from("doc_versions")
      .insert({
        org_id: document.org_id,
        file_id: executedFile.id,
        version_number: 1,
        label: "Executed",
        notes: "Signed via client portal",
        storage_path: executedPath,
        file_name: executedName,
        mime_type: "application/pdf",
        size_bytes: executedBytes.length,
        created_by: uploaderId,
      })
      .select("id")
      .single()

    if (versionError || !version) {
      throw new Error(`Failed to create executed version: ${versionError?.message}`)
    }

    await supabase
      .from("files")
      .update({ current_version_id: version.id })
      .eq("id", executedFile.id)

    await supabase
      .from("documents")
      .update({ status: "signed", executed_file_id: executedFile.id, updated_at: nowIso })
      .eq("id", signingRequest.document_id)

    await supabase
      .from("envelopes")
      .update({
        status: "executed",
        executed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("org_id", signingRequest.org_id)
      .eq("id", envelopeId)

    await recordESignEvent({
      supabase,
      orgId: signingRequest.org_id,
      eventType: ENVELOPE_EVENT_TYPES.executed,
      envelopeId,
      documentId: signingRequest.document_id,
      payload: {
        executed_file_id: executedFile.id,
        executed_at: nowIso,
        source_file_id: sourceFile.id,
        source_sha256: sourceSha256,
        executed_sha256: executedSha256,
        audit_certificate: "appended_to_executed_pdf",
      },
    })

    const proposalId =
      document.source_entity_type === "proposal"
        ? document.source_entity_id
        : (document.metadata?.proposal_id as string | undefined)

    if (proposalId) {
      await acceptProposalFromEnvelopeExecution({
        orgId: signingRequest.org_id,
        proposalId,
        documentId: document.id,
        envelopeId,
        executedFileId: executedFile.id,
        signerName: input.signerName.trim(),
        signerEmail: submittedSignerEmail,
        signerIp,
      })
    }

    const estimateId =
      document.source_entity_type === "estimate"
        ? document.source_entity_id
        : (document.metadata?.estimate_id as string | undefined)

    if (estimateId) {
      await executeEstimateFromEnvelopeExecution({
        orgId: signingRequest.org_id,
        estimateId,
        documentId: document.id,
        envelopeId,
        executedFileId: executedFile.id,
        signerName: input.signerName.trim(),
        signerEmail: submittedSignerEmail,
        signerIp,
      })
    }

    const changeOrderId =
      document.source_entity_type === "change_order"
        ? document.source_entity_id
        : (document.metadata?.change_order_id as string | undefined)

    if (changeOrderId) {
      await approveChangeOrderFromEnvelopeExecution({
        orgId: signingRequest.org_id,
        changeOrderId,
        envelopeId,
        documentId: document.id,
        executedFileId: executedFile.id,
        signerName: input.signerName.trim(),
        signerEmail: submittedSignerEmail,
        signerIp,
      })
    }

    const selectionId =
      document.source_entity_type === "selection"
        ? document.source_entity_id
        : (document.metadata?.selection_id as string | undefined)

    if (selectionId) {
      await confirmSelectionFromEnvelopeExecution({
        orgId: signingRequest.org_id,
        selectionId,
        envelopeId,
        documentId: document.id,
        executedFileId: executedFile.id,
        signerName: input.signerName.trim(),
        signerEmail: submittedSignerEmail,
        signerIp,
      })
    }

    const executedToken = createExecutedFileAccessToken(executedFile.id)
    const executedUrl = buildExecutedDocumentUrl(executedToken)
    executedDocumentUrl = executedUrl
    const metadataRecipients = Array.isArray((document as any).metadata?.envelope_recipients)
      ? ((document as any).metadata.envelope_recipients as Array<{
          name?: string | null
          email?: string | null
          role?: string | null
        }>)
      : []
    const recipients = metadataRecipients
      .map((recipient) => ({
        name: recipient.name?.trim() || "",
        email: recipient.email?.trim() || "",
        role: recipient.role?.trim() || "",
      }))
      .filter((recipient) => recipient.email.length > 0)

    const fallbackRecipients =
      recipients.length > 0
        ? recipients
        : (remaining ?? [])
            .map((request) => ({
              name: "",
              email: request.sent_to_email?.trim() || "",
              role: "signer",
            }))
            .filter((recipient) => recipient.email.length > 0)

    const attachmentContent = Buffer.from(executedBytes).toString("base64")
    await Promise.all(
      fallbackRecipients.map(async (recipient) => {
        const html = await renderEmailTemplate(
          SignatureEmail({
            documentTitle: document.title,
            signingLink: executedUrl,
            recipientName: recipient.name,
            orgName: org?.name ?? null,
            orgLogoUrl: org?.logo_url ?? null,
            eventLabel: "Document Executed",
            headline: "Document fully executed",
            bodyText: `${document.title} has been fully executed.`,
            detailLabel: "Executed Copy",
            detailText: "Open the executed PDF to review the completed document. A copy is also attached to this email.",
            buttonText: "Open Executed PDF",
            previewText: `Document executed: ${document.title}`,
          }),
        )
        await sendEmail({
          to: [recipient.email],
          subject: `Document executed: ${document.title}`,
          html,
          from: getOrgSenderEmail(org?.slug, org?.name),
          attachments: [
            {
              filename: executedName,
              content: attachmentContent,
              contentType: "application/pdf",
            },
          ],
        })
      }),
    )
  } else {
    await supabase
      .from("envelopes")
      .update({
        status: requiredSignedCount > 0 && requiredPendingCount > 0 ? "partially_signed" : "sent",
        updated_at: nowIso,
      })
      .eq("org_id", signingRequest.org_id)
      .eq("id", envelopeId)

    const nextBatch = getNextRequiredSequence((remaining ?? []) as SigningRequestRoutingRow[])
    const sendableNextBatch = (nextBatch ?? []).filter(
      (request) => request.status === "draft" && !!request.sent_to_email,
    )

    await Promise.all(
      sendableNextBatch.map(async (request) => {
        const url = await issueSigningLinkForRequest(supabase, {
          orgId: signingRequest.org_id,
          requestId: request.id,
        })
        const html = await renderEmailTemplate(
          SignatureEmail({
            documentTitle: document.title,
            signingLink: url,
            orgName: org?.name ?? null,
            orgLogoUrl: org?.logo_url ?? null,
            eventLabel: "Signature Request",
            headline: "Document ready for signature",
            bodyText: "The document is now ready for your signature.",
            detailLabel: "Signature",
            detailText: "Open the document to review all pages, complete required fields, and sign electronically.",
            buttonText: "Review and Sign",
          }),
        )

        await sendEmail({
          to: [request.sent_to_email as string],
          subject: `Signature requested: ${document.title}`,
          html,
          from: getOrgSenderEmail(org?.slug, org?.name),
        })
      }),
    )

    if (sendableNextBatch.length > 0) {
      await recordESignEvent({
        supabase,
        orgId: signingRequest.org_id,
        eventType: ENVELOPE_EVENT_TYPES.sent,
        envelopeId,
        documentId: signingRequest.document_id,
        payload: {
          sent_now: sendableNextBatch.length,
          trigger: "next_required_sequence",
        },
      })
    }
  }

  revalidatePath(`/d/${input.token}`)
  return { success: true, executedDocumentUrl }
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
