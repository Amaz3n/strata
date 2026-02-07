"use server"

import { createHmac, randomBytes } from "crypto"

import {
  ENVELOPE_EVENT_TYPES,
  UNIFIED_ESIGN_FEATURE_FLAG_KEY,
  UNIFIED_ESIGN_PHASE0_VERSION,
  buildUnifiedSigningUrl,
  completionEventByEntityType,
  normalizeDraftEnvelopeRecipients,
  normalizeSendEnvelopeRecipients,
  resolveEnvelopeLifecycleStatus,
  type UnifiedSignableEntityType,
} from "@/lib/esign/unified-contracts"
import { createDocument, listDocuments, createDocumentSigningRequest, createDocumentSigningGroup } from "@/lib/services/documents"
import {
  createEnvelopeSigningRequests,
  ensureDraftEnvelopeForDocument,
  replaceEnvelopeRecipients,
} from "@/lib/services/envelopes"
import { recordESignEvent } from "@/lib/services/esign-events"
import { createExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import { listDocumentFields, replaceDocumentFields } from "@/lib/services/documents"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { sendEmail } from "@/lib/services/mailer"
import {
  buildOrgScopedPath,
  getFilesStorageProvider,
  uploadFilesObject,
} from "@/lib/storage/files-storage"

type SigningRequestRoutingRow = {
  id: string
  sequence?: number | null
  required?: boolean | null
  status?: string | null
  sent_to_email?: string | null
  signer_role?: string | null
}

const SOURCE_ENTITY_TYPES: UnifiedSignableEntityType[] = [
  "proposal",
  "change_order",
  "lien_waiver",
  "selection",
  "subcontract",
  "closeout",
  "other",
]

const sourceEntityMetadataIdKeyByType: Record<UnifiedSignableEntityType, string> = {
  proposal: "proposal_id",
  change_order: "change_order_id",
  lien_waiver: "lien_waiver_id",
  selection: "selection_id",
  subcontract: "subcontract_id",
  closeout: "closeout_id",
  other: "source_entity_id",
}

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

async function assertUnifiedESignEnabled(input: { supabase: any; orgId: string }) {
  const enabled = await isFeatureEnabledForOrg({
    supabase: input.supabase,
    orgId: input.orgId,
    flagKey: UNIFIED_ESIGN_FEATURE_FLAG_KEY,
    defaultEnabled: true,
  })

  if (!enabled) {
    throw new Error("Unified e-sign is disabled for this organization")
  }
}

function isUnifiedSignableEntityType(value: unknown): value is UnifiedSignableEntityType {
  return typeof value === "string" && SOURCE_ENTITY_TYPES.includes(value as UnifiedSignableEntityType)
}

function getSourceEntityMetadataIdKey(sourceEntityType: UnifiedSignableEntityType) {
  return sourceEntityMetadataIdKeyByType[sourceEntityType]
}

function getSourceEntityCompletionEvent(sourceEntityType: UnifiedSignableEntityType) {
  if (sourceEntityType === "proposal") return completionEventByEntityType.proposal
  if (sourceEntityType === "change_order") return completionEventByEntityType.change_order
  if (sourceEntityType === "lien_waiver") return completionEventByEntityType.lien_waiver
  if (sourceEntityType === "selection") return completionEventByEntityType.selection
  return null
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
  params: { orgId: string; requestId: string; markSent: boolean },
) {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
  const nowIso = new Date().toISOString()
  const updatePayload: Record<string, any> = {
    token_hash: tokenHash,
    sent_at: nowIso,
  }

  if (params.markSent) {
    updatePayload.status = "sent"
  }

  const { error } = await supabase
    .from("document_signing_requests")
    .update(updatePayload)
    .eq("org_id", params.orgId)
    .eq("id", params.requestId)

  if (error) {
    throw new Error(`Failed to issue signing link: ${error.message}`)
  }

  return {
    url: buildUnifiedSigningUrl(token),
    sentAt: nowIso,
  }
}

async function sendSignerRequestEmail(input: {
  toEmail: string
  documentTitle: string
  signingUrl: string
  recipientName?: string
  isReminder?: boolean
}) {
  const greeting = input.recipientName?.trim() ? `Hi ${input.recipientName.trim()},` : "Hello,"
  const subject = input.isReminder ? `Reminder: Signature requested - ${input.documentTitle}` : `Signature requested: ${input.documentTitle}`

  await sendEmail({
    to: [input.toEmail],
    subject,
    html: `
      <p>${greeting}</p>
      <p>${input.isReminder ? "This is a reminder that your signature is still needed." : "You have a document ready for signature."}</p>
      <p><a href="${input.signingUrl}">Review and sign document</a></p>
      <p>If the button does not work, copy this link:</p>
      <p>${input.signingUrl}</p>
    `,
  })
}

export async function listDocumentsAction(projectId?: string) {
  return listDocuments({ projectId })
}

export async function createDocumentAction(input: {
  project_id: string
  document_type: "proposal" | "contract" | "change_order" | "other"
  title: string
  source_file_id: string
  source_entity_type?: UnifiedSignableEntityType
  source_entity_id?: string
  metadata?: Record<string, any>
}) {
  return createDocument(input)
}

export async function listDocumentFieldsAction(documentId: string, revision = 1) {
  return listDocumentFields({ documentId, revision })
}

type EnvelopeRecipientSuggestion = {
  name: string
  email: string
  source: "contact" | "team"
}

export async function listEnvelopeRecipientSuggestionsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const [contactsResult, membersResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("full_name, email")
      .eq("org_id", orgId)
      .not("email", "is", null)
      .order("updated_at", { ascending: false })
      .limit(250),
    supabase
      .from("memberships")
      .select("status, user:app_users!memberships_user_id_fkey(full_name, email)")
      .eq("org_id", orgId)
      .in("status", ["active", "invited"])
      .limit(250),
  ])

  if (contactsResult.error) {
    throw new Error(`Failed to load contact suggestions: ${contactsResult.error.message}`)
  }
  if (membersResult.error) {
    throw new Error(`Failed to load team suggestions: ${membersResult.error.message}`)
  }

  const byEmail = new Map<string, EnvelopeRecipientSuggestion>()
  const upsert = (suggestion: EnvelopeRecipientSuggestion) => {
    const email = suggestion.email.trim().toLowerCase()
    if (!email) return

    const name = suggestion.name.trim() || suggestion.email.trim()
    const existing = byEmail.get(email)
    if (!existing) {
      byEmail.set(email, { ...suggestion, name, email })
      return
    }

    const preferSource = existing.source === "contact" ? existing.source : suggestion.source
    const preferName = existing.name.trim().length >= name.length ? existing.name : name
    byEmail.set(email, {
      source: preferSource,
      name: preferName,
      email,
    })
  }

  for (const contact of contactsResult.data ?? []) {
    const email = contact.email?.trim()
    if (!email) continue
    upsert({
      source: "contact",
      name: contact.full_name?.trim() || email,
      email,
    })
  }

  for (const member of membersResult.data ?? []) {
    const rawUser = Array.isArray((member as any).user) ? (member as any).user[0] : (member as any).user
    const email = rawUser?.email?.trim()
    if (!email) continue
    upsert({
      source: "team",
      name: rawUser?.full_name?.trim() || email,
      email,
    })
  }

  return Array.from(byEmail.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200)
}

export async function saveDocumentFieldsAction(
  documentId: string,
  revision: number,
  fields: Array<{
    page_index: number
    field_type: "signature" | "initials" | "text" | "date" | "checkbox" | "name"
    label?: string
    required?: boolean
    signer_role?: string
    x: number
    y: number
    w: number
    h: number
    sort_order?: number
    metadata?: Record<string, any>
  }>,
) {
  return replaceDocumentFields({ documentId, revision, fields })
}

export async function getSourceEntityDraftAction(input: {
  source_entity_type: UnifiedSignableEntityType
  source_entity_id: string
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: scopedDraftDocument, error: docsError } = await supabase
    .from("documents")
    .select("id, title, document_type, status, source_file_id, metadata, created_at")
    .eq("org_id", orgId)
    .eq("source_entity_type", input.source_entity_type)
    .eq("source_entity_id", input.source_entity_id)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (docsError) {
    throw new Error(`Failed to load source draft: ${docsError.message}`)
  }

  let draftDocument = scopedDraftDocument

  if (!draftDocument) {
    const metadataEntityKey = getSourceEntityMetadataIdKey(input.source_entity_type)
    const { data: metadataDraftDocument, error: metadataDraftError } = await supabase
      .from("documents")
      .select("id, title, document_type, status, source_file_id, metadata, created_at")
      .eq("org_id", orgId)
      .eq("status", "draft")
      .contains("metadata", { [metadataEntityKey]: input.source_entity_id })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (metadataDraftError) {
      throw new Error(`Failed to load source draft by metadata: ${metadataDraftError.message}`)
    }

    draftDocument = metadataDraftDocument
  }

  if (!draftDocument) return null

  const [fieldsResult, fileResult] = await Promise.all([
    listDocumentFields({ documentId: draftDocument.id, revision: 1 }),
    supabase
      .from("files")
      .select("id, file_name, mime_type")
      .eq("org_id", orgId)
      .eq("id", draftDocument.source_file_id)
      .maybeSingle(),
  ])

  if (fileResult.error || !fileResult.data) {
    throw new Error(`Failed to load source file: ${fileResult.error?.message ?? "missing"}`)
  }

  const { data: draftEnvelope } = await supabase
    .from("envelopes")
    .select("id")
    .eq("org_id", orgId)
    .eq("document_id", draftDocument.id)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let draftRecipients: Array<Record<string, any>> =
    Array.isArray(draftDocument.metadata?.draft_recipients) ? draftDocument.metadata.draft_recipients : []

  if (draftEnvelope?.id) {
    const { data: envelopeRecipients, error: envelopeRecipientsError } = await supabase
      .from("envelope_recipients")
      .select("recipient_type, contact_id, user_id, name, email, role, signer_role, sequence, required")
      .eq("org_id", orgId)
      .eq("envelope_id", draftEnvelope.id)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    if (!envelopeRecipientsError && envelopeRecipients) {
      draftRecipients = envelopeRecipients.map((recipient) => ({
        type: recipient.recipient_type,
        contact_id: recipient.contact_id,
        user_id: recipient.user_id,
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        signer_role: recipient.signer_role,
        sequence: recipient.sequence,
        required: recipient.required,
      }))
    }
  }
  const signingOrderEnabled =
    typeof draftDocument.metadata?.draft_signing_order_enabled === "boolean"
      ? draftDocument.metadata.draft_signing_order_enabled
      : true

  return {
    document: {
      id: draftDocument.id,
      title: draftDocument.title,
      document_type: draftDocument.document_type,
      source_file_id: draftDocument.source_file_id,
    },
    file: fileResult.data,
    fields: fieldsResult,
    recipients: draftRecipients,
    signing_order_enabled: signingOrderEnabled,
  }
}

export async function getProposalDraftAction(proposalId: string) {
  return getSourceEntityDraftAction({
    source_entity_type: "proposal",
    source_entity_id: proposalId,
  })
}

export async function saveDocumentDraftEnvelopeAction(input: {
  document_id: string
  source_entity_type: UnifiedSignableEntityType
  source_entity_id: string
  title: string
  signing_order_enabled?: boolean
  recipients: Array<{
    type?: "external_email" | "contact" | "internal_user"
    name?: string
    email?: string
    contact_id?: string
    user_id?: string
    role?: "signer" | "cc"
    signer_role?: string
    sequence?: number
    required?: boolean
  }>
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, org_id, status, metadata, source_entity_type, source_entity_id")
    .eq("org_id", orgId)
    .eq("id", input.document_id)
    .maybeSingle()

  if (documentError || !document) {
    throw new Error(`Draft document not found: ${documentError?.message ?? "missing"}`)
  }

  if (document.status !== "draft") {
    throw new Error("Only draft envelopes can be updated")
  }
  if (
    document.source_entity_type &&
    document.source_entity_id &&
    (document.source_entity_type !== input.source_entity_type || document.source_entity_id !== input.source_entity_id)
  ) {
    throw new Error("Draft document is linked to a different source entity")
  }

  const normalizedRecipients = normalizeDraftEnvelopeRecipients(input.recipients ?? [])
  const metadataEntityKey = getSourceEntityMetadataIdKey(input.source_entity_type)
  const completionEvent = getSourceEntityCompletionEvent(input.source_entity_type)

  const metadata = {
    ...(document.metadata ?? {}),
    [metadataEntityKey]: input.source_entity_id,
    source_entity_type: input.source_entity_type,
    source_entity_id: input.source_entity_id,
    ...(completionEvent ? { completion_event: completionEvent } : {}),
    unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
    draft_recipients: normalizedRecipients,
    draft_signing_order_enabled: input.signing_order_enabled ?? true,
  }

  const title = input.title.trim() || "Document"
  const { error: updateError } = await supabase
    .from("documents")
    .update({
      title,
      source_entity_type: input.source_entity_type,
      source_entity_id: input.source_entity_id,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("id", input.document_id)

  if (updateError) {
    throw new Error(`Failed to update draft envelope: ${updateError.message}`)
  }

  const draftEnvelope = await ensureDraftEnvelopeForDocument(
    {
      document_id: input.document_id,
      source_entity_type: input.source_entity_type,
      source_entity_id: input.source_entity_id,
      metadata: {
        [metadataEntityKey]: input.source_entity_id,
        ...(completionEvent ? { completion_event: completionEvent } : {}),
        unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
      },
    },
    orgId,
  )

  const recipientRows = normalizedRecipients.map((recipient, index) => ({
    recipient_type: recipient.type,
    contact_id: recipient.contact_id,
    user_id: recipient.user_id,
    name: recipient.name || undefined,
    email: recipient.email || undefined,
    role: recipient.role,
    signer_role: recipient.role === "signer" ? recipient.signer_role ?? `signer_${index + 1}` : undefined,
    sequence: recipient.sequence ?? (recipient.role === "signer" ? index + 1 : Math.max(index + 1, 1)),
    required: recipient.required,
  }))

  await replaceEnvelopeRecipients(
    {
      envelope_id: draftEnvelope.id,
      recipients: recipientRows,
    },
    orgId,
  )

  return { success: true }
}

export async function saveProposalDraftEnvelopeAction(input: {
  document_id: string
  proposal_id: string
  title: string
  signing_order_enabled?: boolean
  recipients: Array<{
    type?: "external_email" | "contact" | "internal_user"
    name?: string
    email?: string
    contact_id?: string
    user_id?: string
    role?: "signer" | "cc"
    signer_role?: string
    sequence?: number
    required?: boolean
  }>
}) {
  return saveDocumentDraftEnvelopeAction({
    document_id: input.document_id,
    source_entity_type: "proposal",
    source_entity_id: input.proposal_id,
    title: input.title,
    signing_order_enabled: input.signing_order_enabled,
    recipients: input.recipients,
  })
}

export async function createDocumentSigningRequestAction(input: {
  document_id: string
  recipient_contact_id?: string
  sent_to_email?: string
  expires_at?: string
  max_uses?: number
  signer_role?: string
  sequence?: number
  required?: boolean
  group_id?: string
  envelope_id?: string
  envelope_recipient_id?: string
}) {
  return createDocumentSigningRequest(input)
}

export async function createDocumentSigningGroupAction(input: {
  document_id: string
  envelope_id?: string
  signers: Array<{
    signer_role: string
    recipient_contact_id?: string
    sent_to_email?: string
    envelope_recipient_id?: string
    sequence?: number
    required?: boolean
    expires_at?: string
    max_uses?: number
  }>
}) {
  return createDocumentSigningGroup(input)
}

export async function sendDocumentEnvelopeAction(input: {
  document_id: string
  recipients: Array<{
    type?: "external_email" | "contact" | "internal_user"
    name?: string
    email?: string
    contact_id?: string
    user_id?: string
    role: "signer" | "cc"
    signer_role?: string
    sequence?: number
    required?: boolean
  }>
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const recipients = normalizeSendEnvelopeRecipients(input.recipients ?? [])
  const signers = recipients.filter((recipient) => recipient.role === "signer")
  const ccRecipients = recipients.filter((recipient) => recipient.role === "cc")
  if (signers.length === 0) {
    throw new Error("At least one signer is required")
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, title, metadata, current_revision, source_entity_type, source_entity_id")
    .eq("org_id", orgId)
    .eq("id", input.document_id)
    .single()

  if (documentError || !document) {
    throw new Error(`Failed to load document: ${documentError?.message ?? "Not found"}`)
  }

  const nowIso = new Date().toISOString()
  const sourceEntityType = isUnifiedSignableEntityType(document.source_entity_type)
    ? document.source_entity_type
    : isUnifiedSignableEntityType(document.metadata?.source_entity_type)
      ? document.metadata.source_entity_type
      : undefined
  const sourceEntityId = document.source_entity_id ?? document.metadata?.source_entity_id ?? undefined

  if (sourceEntityType === "proposal" && sourceEntityId) {
    const [{ data: proposal, error: proposalError }, { data: executedEnvelope, error: executedEnvelopeError }] =
      await Promise.all([
        supabase
          .from("proposals")
          .select("id, status, accepted_at")
          .eq("org_id", orgId)
          .eq("id", sourceEntityId)
          .maybeSingle(),
        supabase
          .from("envelopes")
          .select("id")
          .eq("org_id", orgId)
          .eq("source_entity_type", "proposal")
          .eq("source_entity_id", sourceEntityId)
          .eq("status", "executed")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

    if (proposalError) {
      throw new Error(`Failed to validate proposal status: ${proposalError.message}`)
    }
    if (executedEnvelopeError) {
      throw new Error(`Failed to validate proposal envelope history: ${executedEnvelopeError.message}`)
    }

    if (proposal?.status === "accepted" || proposal?.accepted_at) {
      throw new Error("This proposal has already been accepted and cannot request a new signature envelope.")
    }
    if (executedEnvelope?.id) {
      throw new Error("An executed signature envelope already exists for this proposal.")
    }
  }

  const sourceEntityMetadataKey = sourceEntityType ? getSourceEntityMetadataIdKey(sourceEntityType) : undefined
  const envelopeMetadata = {
    ...(document.metadata ?? {}),
    ...(sourceEntityMetadataKey && sourceEntityId ? { [sourceEntityMetadataKey]: sourceEntityId } : {}),
    unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
  }

  const envelope = await ensureDraftEnvelopeForDocument(
    {
      document_id: document.id,
      source_entity_type: sourceEntityType,
      source_entity_id: sourceEntityId,
      document_revision: document.current_revision ?? 1,
      metadata: envelopeMetadata,
    },
    orgId,
  )

  const envelopeRecipientRows = recipients.map((recipient, index) => ({
    recipient_type: recipient.type,
    contact_id: recipient.contact_id,
    user_id: recipient.user_id,
    name: recipient.name || undefined,
    email: recipient.email || undefined,
    role: recipient.role,
    signer_role: recipient.role === "signer" ? recipient.signer_role ?? `signer_${index + 1}` : undefined,
    sequence: recipient.sequence ?? (recipient.role === "signer" ? index + 1 : Math.max(index + 1, 1)),
    required: recipient.required,
    metadata: {},
  }))

  const savedRecipients = await replaceEnvelopeRecipients(
    {
      envelope_id: envelope.id,
      recipients: envelopeRecipientRows,
    },
    orgId,
  )

  const signingRequestsResult = await createEnvelopeSigningRequests(
    {
      envelope_id: envelope.id,
    },
    orgId,
  )

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: ENVELOPE_EVENT_TYPES.created,
    envelopeId: envelope.id,
    documentId: document.id,
    payload: {
      source: "documents.sendDocumentEnvelopeAction",
      signer_count: signers.length,
      cc_count: ccRecipients.length,
    },
  })

  const signerNameByRole = new Map(
    recipients
      .filter((recipient) => recipient.role === "signer")
      .map((recipient, index) => [recipient.signer_role ?? `signer_${index + 1}`, recipient.name ?? ""]),
  )
  const firstBatch = getNextRequiredSequence(signingRequestsResult.requests ?? [])
  const sendableFirstBatch = (firstBatch ?? []).filter((request) => request.status === "draft" && !!request.sent_to_email)

  await Promise.all(
    sendableFirstBatch.map(async (request) => {
      const link = await issueSigningLinkForRequest(supabase, {
        orgId,
        requestId: request.id,
        markSent: true,
      })

      await sendSignerRequestEmail({
        toEmail: request.sent_to_email as string,
        documentTitle: document.title,
        signingUrl: link.url,
        recipientName: signerNameByRole.get(request.signer_role ?? "") ?? "",
      })
    }),
  )

  const envelopeRecipients = savedRecipients.map((recipient: any) => ({
    type: recipient.recipient_type,
    name: recipient.name ?? null,
    email: recipient.email ?? null,
    contact_id: recipient.contact_id ?? null,
    user_id: recipient.user_id ?? null,
    role: recipient.role,
    signer_role: recipient.signer_role || null,
    sequence: recipient.sequence ?? null,
    required: recipient.required,
  }))
  const metadata = {
    ...(document.metadata ?? {}),
    envelope_recipients: envelopeRecipients,
    unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
  }
  const { error: documentUpdateError } = await supabase
    .from("documents")
    .update({ status: "sent", metadata, updated_at: nowIso })
    .eq("org_id", orgId)
    .eq("id", input.document_id)

  if (documentUpdateError) {
    throw new Error(`Failed to mark document as sent: ${documentUpdateError.message}`)
  }

  const { error: envelopeUpdateError } = await supabase
    .from("envelopes")
    .update({
      status: "sent",
      sent_at: nowIso,
      updated_at: nowIso,
      metadata: envelopeMetadata,
    })
    .eq("org_id", orgId)
    .eq("id", envelope.id)

  if (envelopeUpdateError) {
    throw new Error(`Failed to mark envelope as sent: ${envelopeUpdateError.message}`)
  }

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: ENVELOPE_EVENT_TYPES.sent,
    envelopeId: envelope.id,
    documentId: document.id,
    payload: {
      source: "documents.sendDocumentEnvelopeAction",
      sent_now: sendableFirstBatch.length,
      pending_signers: Math.max(signers.length - sendableFirstBatch.length, 0),
      signer_count: signers.length,
    },
  })

  return {
    success: true,
    envelopeId: envelope.id,
    groupId: envelope.id,
    signerCount: signers.length,
    ccCount: ccRecipients.length,
    sentNow: sendableFirstBatch.length,
    pendingSigners: Math.max(signers.length - sendableFirstBatch.length, 0),
  }
}

export async function getProposalEnvelopeStatusAction(proposalId: string) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select("id, org_id, project_id, title")
    .eq("org_id", orgId)
    .eq("id", proposalId)
    .maybeSingle()

  if (proposalError || !proposal) {
    throw new Error(`Proposal not found: ${proposalError?.message ?? "missing"}`)
  }

  if (!proposal.project_id) {
    return {
      proposal: { id: proposal.id, title: proposal.title },
      document: null,
      signers: [],
      summary: {
        total: 0,
        signed: 0,
        viewed: 0,
        pending: 0,
      },
    }
  }

  const { data: projectDocs, error: docsError } = await supabase
    .from("documents")
    .select("id, title, status, created_at, updated_at, executed_file_id, metadata")
    .eq("org_id", orgId)
    .eq("project_id", proposal.project_id)
    .eq("document_type", "proposal")
    .order("created_at", { ascending: false })

  if (docsError) {
    throw new Error(`Failed to load proposal documents: ${docsError.message}`)
  }

  const proposalDocument =
    (projectDocs ?? []).find((doc) => doc.metadata?.proposal_id === proposal.id) ?? null

  if (!proposalDocument) {
    return {
      proposal: { id: proposal.id, title: proposal.title },
      document: null,
      signers: [],
      summary: {
        total: 0,
        signed: 0,
        viewed: 0,
        pending: 0,
      },
    }
  }

  const { data: latestEnvelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, status, sent_at, executed_at, created_at")
    .eq("org_id", orgId)
    .eq("document_id", proposalDocument.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (envelopeError) {
    throw new Error(`Failed to load envelope: ${envelopeError.message}`)
  }

  let requestsQuery = supabase
    .from("document_signing_requests")
    .select("id, status, sent_to_email, signer_role, sequence, required, sent_at, viewed_at, signed_at, created_at")
    .eq("org_id", orgId)
    .order("sequence", { ascending: true })
    .order("created_at", { ascending: true })

  if (latestEnvelope?.id) {
    requestsQuery = requestsQuery.eq("envelope_id", latestEnvelope.id)
  } else {
    requestsQuery = requestsQuery.eq("document_id", proposalDocument.id)
  }

  const { data: requests, error: requestsError } = await requestsQuery

  if (requestsError) {
    throw new Error(`Failed to load signer statuses: ${requestsError.message}`)
  }

  const requestIds = (requests ?? []).map((request) => request.id)
  let signatureByRequestId = new Map<string, { signer_name?: string | null; signer_email?: string | null; created_at?: string | null }>()

  if (requestIds.length > 0) {
    const { data: signatures, error: signaturesError } = await supabase
      .from("document_signatures")
      .select("signing_request_id, signer_name, signer_email, created_at")
      .in("signing_request_id", requestIds)
      .order("created_at", { ascending: false })

    if (signaturesError) {
      throw new Error(`Failed to load signatures: ${signaturesError.message}`)
    }

    signatureByRequestId = new Map(
      (signatures ?? []).map((signature) => [
        signature.signing_request_id,
        {
          signer_name: signature.signer_name,
          signer_email: signature.signer_email,
          created_at: signature.created_at,
        },
      ]),
    )
  }

  const requiredRequests = (requests ?? []).filter((request) => request.required !== false)
  const nextPendingSequence =
    requiredRequests.find(
      (request) =>
        request.status !== "signed" &&
        request.status !== "voided" &&
        request.status !== "expired",
    )?.sequence ?? null

  const signerRows = requiredRequests.map((request) => {
      const signature = signatureByRequestId.get(request.id)
      return {
        id: request.id,
        sequence: request.sequence ?? 1,
        signer_role: request.signer_role ?? null,
        email: request.sent_to_email ?? signature?.signer_email ?? null,
        signer_name: signature?.signer_name ?? null,
        status: request.status ?? "draft",
        sent_at: request.sent_at ?? null,
        viewed_at: request.viewed_at ?? null,
        signed_at: request.signed_at ?? signature?.created_at ?? null,
        can_remind:
          !!request.sent_to_email &&
          (nextPendingSequence == null || (request.sequence ?? 1) === nextPendingSequence) &&
          request.status !== "signed" &&
          request.status !== "voided" &&
          request.status !== "expired",
      }
    })

  const signedCount = signerRows.filter((request) => request.status === "signed").length
  const viewedCount = signerRows.filter((request) => request.viewed_at).length
  const envelopeStatus = latestEnvelope?.status
    ? latestEnvelope.status
    : resolveEnvelopeLifecycleStatus({
        documentStatus: proposalDocument.status,
        requiredSignerCount: signerRows.length,
        requiredSignedCount: signedCount,
      })

  return {
    proposal: { id: proposal.id, title: proposal.title },
    document: {
      id: proposalDocument.id,
      title: proposalDocument.title,
      status: proposalDocument.status,
      envelope_status: envelopeStatus,
      envelope_id: latestEnvelope?.id ?? null,
      executed_file_id: proposalDocument.executed_file_id,
      created_at: proposalDocument.created_at,
      updated_at: proposalDocument.updated_at,
    },
    signers: signerRows,
    summary: {
      total: signerRows.length,
      signed: signedCount,
      viewed: viewedCount,
      pending: Math.max(signerRows.length - signedCount, 0),
    },
  }
}

export async function sendDocumentSigningReminderAction(signingRequestId: string) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  const { data: request, error: requestError } = await supabase
    .from("document_signing_requests")
    .select("id, org_id, document_id, group_id, envelope_id, sequence, required, status, sent_to_email, signer_role")
    .eq("org_id", orgId)
    .eq("id", signingRequestId)
    .maybeSingle()

  if (requestError || !request) {
    throw new Error(`Signing request not found: ${requestError?.message ?? "missing"}`)
  }

  if (!request.sent_to_email) {
    throw new Error("This signer does not have an email address")
  }
  if (request.status === "signed") {
    throw new Error("This signer has already completed signature")
  }
  if (request.status === "voided" || request.status === "expired") {
    throw new Error("This signing request is no longer active")
  }

  let groupRequestsQuery = supabase
    .from("document_signing_requests")
    .select("id, sequence, required, status")
    .eq("org_id", orgId)
    .order("sequence", { ascending: true })

  if (request.envelope_id) {
    groupRequestsQuery = groupRequestsQuery.eq("envelope_id", request.envelope_id)
  } else {
    groupRequestsQuery = groupRequestsQuery.eq("group_id", request.group_id ?? request.id)
  }

  const { data: groupRequests, error: groupRequestsError } = await groupRequestsQuery

  if (groupRequestsError) {
    throw new Error(`Failed to load signing group: ${groupRequestsError.message}`)
  }

  const nextPendingSequence =
    (groupRequests ?? []).find(
      (item) =>
        item.required !== false &&
        item.status !== "signed" &&
        item.status !== "voided" &&
        item.status !== "expired",
    )?.sequence ?? null

  if (nextPendingSequence != null && (request.sequence ?? 1) !== nextPendingSequence) {
    throw new Error("This signer is not currently active in the signing order")
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, title")
    .eq("org_id", orgId)
    .eq("id", request.document_id)
    .single()

  if (documentError || !document) {
    throw new Error(`Document not found: ${documentError?.message ?? "missing"}`)
  }

  const link = await issueSigningLinkForRequest(supabase, {
    orgId,
    requestId: request.id,
    markSent: request.status === "draft",
  })

  await sendSignerRequestEmail({
    toEmail: request.sent_to_email,
    documentTitle: document.title,
    signingUrl: link.url,
    isReminder: true,
  })

  return {
    success: true,
    sentAt: link.sentAt,
  }
}

type SignaturesHubRow = {
  envelope_id: string
  document_id: string
  document_title: string
  document_type: string
  document_status: string
  project_id: string
  project_name: string | null
  source_entity_type: string | null
  source_entity_id: string | null
  envelope_status: string
  created_at: string
  sent_at: string | null
  executed_at: string | null
  expires_at: string | null
  voided_at: string | null
  signer_summary: {
    total: number
    signed: number
    viewed: number
    pending: number
  }
  next_pending_request_id: string | null
  next_pending_sequence: number | null
  next_pending_emails: string[]
  recipient_names: string[]
  next_pending_names: string[]
  last_event_at: string | null
  can_remind: boolean
  can_void: boolean
  can_resend: boolean
  can_download: boolean
  queue_flags: {
    waiting_on_client: boolean
    executed_this_week: boolean
    expiring_soon: boolean
  }
}

type SignaturesHubSummary = {
  total: number
  waiting_on_client: number
  executed_this_week: number
  expiring_soon: number
}

export async function listSignaturesHubAction(input?: { projectId?: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  let envelopeQuery = supabase
    .from("envelopes")
    .select(
      "id, org_id, project_id, document_id, source_entity_type, source_entity_id, status, sent_at, executed_at, expires_at, voided_at, created_at, metadata, documents!inner(id, title, document_type, status, executed_file_id)",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(500)

  if (input?.projectId) {
    envelopeQuery = envelopeQuery.eq("project_id", input.projectId)
  }

  const { data: envelopeRows, error: envelopeError } = await envelopeQuery
  if (envelopeError) {
    throw new Error(`Failed to load signatures hub: ${envelopeError.message}`)
  }

  const envelopes = envelopeRows ?? []
  if (envelopes.length === 0) {
    return {
      rows: [] as SignaturesHubRow[],
      summary: {
        total: 0,
        waiting_on_client: 0,
        executed_this_week: 0,
        expiring_soon: 0,
      } as SignaturesHubSummary,
      generated_at: new Date().toISOString(),
    }
  }

  const envelopeIds = envelopes.map((row: any) => row.id)
  const projectIds = Array.from(new Set(envelopes.map((row: any) => row.project_id).filter(Boolean)))

  const [requestsResult, projectsResult, recipientsResult, envelopeEventsResult] = await Promise.all([
    supabase
      .from("document_signing_requests")
      .select(
        "id, envelope_id, envelope_recipient_id, sequence, required, status, sent_to_email, viewed_at, signed_at, created_at",
      )
      .eq("org_id", orgId)
      .in("envelope_id", envelopeIds)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true }),
    projectIds.length > 0
      ? supabase
          .from("projects")
          .select("id, name")
          .eq("org_id", orgId)
          .in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("envelope_recipients")
      .select("id, envelope_id, role, name, sequence, created_at")
      .eq("org_id", orgId)
      .in("envelope_id", envelopeIds)
      .eq("role", "signer")
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("envelope_events")
      .select("envelope_id, created_at")
      .eq("org_id", orgId)
      .in("envelope_id", envelopeIds)
      .order("created_at", { ascending: false }),
  ])

  if (requestsResult.error) {
    throw new Error(`Failed to load signing requests for hub: ${requestsResult.error.message}`)
  }
  if (projectsResult.error) {
    throw new Error(`Failed to load project names for hub: ${projectsResult.error.message}`)
  }
  if (recipientsResult.error) {
    throw new Error(`Failed to load envelope recipients for hub: ${recipientsResult.error.message}`)
  }
  if (envelopeEventsResult.error) {
    throw new Error(`Failed to load envelope events for hub: ${envelopeEventsResult.error.message}`)
  }

  const requestsByEnvelopeId = new Map<string, any[]>()
  for (const request of requestsResult.data ?? []) {
    const rows = requestsByEnvelopeId.get(request.envelope_id) ?? []
    rows.push(request)
    requestsByEnvelopeId.set(request.envelope_id, rows)
  }

  const projectNameById = new Map<string, string>(
    (projectsResult.data ?? []).map((project) => [project.id, project.name]),
  )
  const recipientsByEnvelopeId = new Map<
    string,
    Array<{ id: string; name: string | null; sequence: number | null }>
  >()
  const recipientNameById = new Map<string, string>()
  for (const recipient of recipientsResult.data ?? []) {
    const rows = recipientsByEnvelopeId.get(recipient.envelope_id) ?? []
    rows.push({
      id: recipient.id,
      name: recipient.name ?? null,
      sequence: recipient.sequence ?? null,
    })
    recipientsByEnvelopeId.set(recipient.envelope_id, rows)
    if (recipient.name?.trim()) {
      recipientNameById.set(recipient.id, recipient.name.trim())
    }
  }
  const latestEventAtByEnvelopeId = new Map<string, string>()
  for (const event of envelopeEventsResult.data ?? []) {
    if (!latestEventAtByEnvelopeId.has(event.envelope_id)) {
      latestEventAtByEnvelopeId.set(event.envelope_id, event.created_at)
    }
  }

  const nowMs = Date.now()
  const weekMs = 7 * 24 * 60 * 60 * 1000

  const rows: SignaturesHubRow[] = envelopes.map((envelope: any) => {
    const rawDocument = Array.isArray(envelope.documents) ? envelope.documents[0] : envelope.documents
    const document = rawDocument ?? {}
    const requests = (requestsByEnvelopeId.get(envelope.id) ?? []) as Array<{
      id: string
      envelope_recipient_id?: string | null
      sequence?: number | null
      required?: boolean | null
      status?: string | null
      sent_to_email?: string | null
      viewed_at?: string | null
      signed_at?: string | null
      created_at?: string | null
    }>
    const recipients = recipientsByEnvelopeId.get(envelope.id) ?? []

    const requiredRequests = requests.filter((request) => request.required !== false)
    const signedCount = requiredRequests.filter((request) => request.status === "signed").length
    const viewedCount = requiredRequests.filter((request) => !!request.viewed_at).length
    const pendingRequests = requiredRequests.filter(
      (request) =>
        request.status !== "signed" &&
        request.status !== "voided" &&
        request.status !== "expired",
    )
    const nextPendingSequence = pendingRequests[0]?.sequence ?? null
    const nextPendingRequests =
      nextPendingSequence == null
        ? []
        : pendingRequests.filter((request) => (request.sequence ?? 1) === nextPendingSequence)
    const recipientNames = recipients
      .map((recipient) => recipient.name?.trim() ?? "")
      .filter((name) => name.length > 0)
    const nextPendingNames = nextPendingRequests
      .map((request) => {
        if (request.envelope_recipient_id) {
          return recipientNameById.get(request.envelope_recipient_id) ?? ""
        }
        return ""
      })
      .filter((name) => name.length > 0)
    const fallbackPendingNames =
      nextPendingNames.length > 0
        ? nextPendingNames
        : recipients
            .filter((recipient) => (recipient.sequence ?? 1) === (nextPendingSequence ?? -1))
            .map((recipient) => recipient.name?.trim() ?? "")
            .filter((name) => name.length > 0)

    const waitingOnClient =
      (envelope.status === "sent" || envelope.status === "partially_signed") &&
      pendingRequests.length > 0
    const executedThisWeek =
      envelope.status === "executed" &&
      !!envelope.executed_at &&
      nowMs - new Date(envelope.executed_at).getTime() <= weekMs
    const expiringSoon =
      (envelope.status === "sent" || envelope.status === "partially_signed") &&
      !!envelope.expires_at &&
      new Date(envelope.expires_at).getTime() > nowMs &&
      new Date(envelope.expires_at).getTime() - nowMs <= weekMs

    return {
      envelope_id: envelope.id,
      document_id: envelope.document_id,
      document_title: document.title ?? "Document",
      document_type: document.document_type ?? "other",
      document_status: document.status ?? envelope.status,
      project_id: envelope.project_id,
      project_name: projectNameById.get(envelope.project_id) ?? null,
      source_entity_type: envelope.source_entity_type ?? null,
      source_entity_id: envelope.source_entity_id ?? null,
      envelope_status: envelope.status,
      created_at: envelope.created_at,
      sent_at: envelope.sent_at ?? null,
      executed_at: envelope.executed_at ?? null,
      expires_at: envelope.expires_at ?? null,
      voided_at: envelope.voided_at ?? null,
      signer_summary: {
        total: requiredRequests.length,
        signed: signedCount,
        viewed: viewedCount,
        pending: Math.max(requiredRequests.length - signedCount, 0),
      },
      next_pending_request_id: nextPendingRequests[0]?.id ?? null,
      next_pending_sequence: nextPendingSequence,
      next_pending_emails: nextPendingRequests
        .map((request) => request.sent_to_email?.trim() ?? "")
        .filter((email) => email.length > 0),
      recipient_names: recipientNames,
      next_pending_names: fallbackPendingNames,
      last_event_at:
        latestEventAtByEnvelopeId.get(envelope.id) ??
        pendingRequests
          .flatMap((request) => [request.signed_at, request.viewed_at, request.created_at])
          .filter((value): value is string => !!value)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ??
        envelope.executed_at ??
        envelope.voided_at ??
        envelope.sent_at ??
        envelope.created_at ??
        null,
      can_remind:
        (envelope.status === "sent" || envelope.status === "partially_signed") &&
        nextPendingRequests.some((request) => !!request.sent_to_email),
      can_void: envelope.status === "draft" || envelope.status === "sent" || envelope.status === "partially_signed",
      can_resend: envelope.status !== "executed",
      can_download: envelope.status === "executed",
      queue_flags: {
        waiting_on_client: waitingOnClient,
        executed_this_week: executedThisWeek,
        expiring_soon: expiringSoon,
      },
    }
  })

  const summary = rows.reduce<SignaturesHubSummary>(
    (acc, row) => {
      acc.total += 1
      if (row.queue_flags.waiting_on_client) acc.waiting_on_client += 1
      if (row.queue_flags.executed_this_week) acc.executed_this_week += 1
      if (row.queue_flags.expiring_soon) acc.expiring_soon += 1
      return acc
    },
    {
      total: 0,
      waiting_on_client: 0,
      executed_this_week: 0,
      expiring_soon: 0,
    },
  )

  return {
    rows,
    summary,
    generated_at: new Date().toISOString(),
  }
}

export async function voidEnvelopeAction(input: { envelopeId: string; reason?: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, org_id, document_id, status, metadata")
    .eq("org_id", orgId)
    .eq("id", input.envelopeId)
    .maybeSingle()

  if (envelopeError || !envelope) {
    throw new Error(`Envelope not found: ${envelopeError?.message ?? "missing"}`)
  }
  if (envelope.status === "executed") {
    throw new Error("Executed envelopes cannot be voided")
  }
  if (envelope.status === "voided") {
    return { success: true, idempotent: true }
  }

  const nowIso = new Date().toISOString()
  const nextMetadata = {
    ...(envelope.metadata ?? {}),
    void_reason: input.reason?.trim() || null,
    voided_by_user_id: userId,
    voided_via: "signatures_hub",
  }

  const { error: updateEnvelopeError } = await supabase
    .from("envelopes")
    .update({
      status: "voided",
      voided_at: nowIso,
      updated_at: nowIso,
      metadata: nextMetadata,
    })
    .eq("org_id", orgId)
    .eq("id", envelope.id)

  if (updateEnvelopeError) {
    throw new Error(`Failed to void envelope: ${updateEnvelopeError.message}`)
  }

  const { error: updateRequestsError } = await supabase
    .from("document_signing_requests")
    .update({ status: "voided" })
    .eq("org_id", orgId)
    .eq("envelope_id", envelope.id)
    .in("status", ["draft", "sent", "viewed"])

  if (updateRequestsError) {
    throw new Error(`Failed to void outstanding signing requests: ${updateRequestsError.message}`)
  }

  const { count: activeEnvelopeCount, error: activeEnvelopeError } = await supabase
    .from("envelopes")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("document_id", envelope.document_id)
    .in("status", ["draft", "sent", "partially_signed"])

  if (activeEnvelopeError) {
    throw new Error(`Failed to check active envelopes: ${activeEnvelopeError.message}`)
  }

  if ((activeEnvelopeCount ?? 0) === 0) {
    const { error: documentStatusError } = await supabase
      .from("documents")
      .update({
        status: "voided",
        updated_at: nowIso,
      })
      .eq("org_id", orgId)
      .eq("id", envelope.document_id)
      .in("status", ["draft", "sent", "expired", "voided"])

    if (documentStatusError) {
      throw new Error(`Failed to update document status after void: ${documentStatusError.message}`)
    }
  }

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: ENVELOPE_EVENT_TYPES.voided,
    envelopeId: envelope.id,
    documentId: envelope.document_id,
    payload: {
      source: "documents.voidEnvelopeAction",
      reason: input.reason?.trim() || null,
    },
  })

  return { success: true, idempotent: false }
}

export async function resendEnvelopeAction(input: { envelopeId: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: sourceEnvelopeRaw, error: sourceEnvelopeError } = await supabase
    .from("envelopes")
    .select(
      "id, org_id, project_id, document_id, document_revision, source_entity_type, source_entity_id, status, subject, message, expires_at, metadata, documents!inner(id, title, metadata)",
    )
    .eq("org_id", orgId)
    .eq("id", input.envelopeId)
    .maybeSingle()

  if (sourceEnvelopeError || !sourceEnvelopeRaw) {
    throw new Error(`Envelope not found: ${sourceEnvelopeError?.message ?? "missing"}`)
  }
  if (sourceEnvelopeRaw.status === "executed") {
    throw new Error("Executed envelopes cannot be resent")
  }

  const sourceEnvelope = sourceEnvelopeRaw as any
  const sourceDocument = Array.isArray(sourceEnvelope.documents)
    ? sourceEnvelope.documents[0]
    : sourceEnvelope.documents

  const { data: sourceRecipients, error: recipientsError } = await supabase
    .from("envelope_recipients")
    .select("recipient_type, contact_id, user_id, name, email, role, signer_role, sequence, required, metadata")
    .eq("org_id", orgId)
    .eq("envelope_id", sourceEnvelope.id)
    .order("sequence", { ascending: true })
    .order("created_at", { ascending: true })

  if (recipientsError) {
    throw new Error(`Failed to load envelope recipients: ${recipientsError.message}`)
  }

  const normalizedRecipients = sourceRecipients ?? []
  const signerCount = normalizedRecipients.filter((recipient) => recipient.role === "signer").length
  if (signerCount === 0) {
    throw new Error("Envelope has no signer recipients to resend")
  }

  const nowIso = new Date().toISOString()
  if (
    sourceEnvelope.status === "draft" ||
    sourceEnvelope.status === "sent" ||
    sourceEnvelope.status === "partially_signed"
  ) {
    await voidEnvelopeAction({
      envelopeId: sourceEnvelope.id,
      reason: "Superseded by resend",
    })
  }

  const newEnvelopeMetadata = {
    ...(sourceEnvelope.metadata ?? {}),
    resend_of_envelope_id: sourceEnvelope.id,
    resend_requested_at: nowIso,
    resend_requested_by: userId,
  }

  const { data: createdEnvelope, error: createEnvelopeError } = await supabase
    .from("envelopes")
    .insert({
      org_id: orgId,
      project_id: sourceEnvelope.project_id,
      document_id: sourceEnvelope.document_id,
      document_revision: sourceEnvelope.document_revision ?? 1,
      source_entity_type: sourceEnvelope.source_entity_type ?? null,
      source_entity_id: sourceEnvelope.source_entity_id ?? null,
      status: "draft",
      subject: sourceEnvelope.subject ?? null,
      message: sourceEnvelope.message ?? null,
      expires_at: sourceEnvelope.expires_at ?? null,
      metadata: newEnvelopeMetadata,
      created_by: userId,
    })
    .select("id")
    .single()

  if (createEnvelopeError || !createdEnvelope) {
    throw new Error(`Failed to create resend envelope: ${createEnvelopeError?.message ?? "missing"}`)
  }

  const recipientRows = normalizedRecipients.map((recipient) => ({
    org_id: orgId,
    envelope_id: createdEnvelope.id,
    recipient_type: recipient.recipient_type,
    contact_id: recipient.contact_id ?? null,
    user_id: recipient.user_id ?? null,
    name: recipient.name ?? null,
    email: recipient.email ?? null,
    role: recipient.role,
    signer_role: recipient.signer_role ?? null,
    sequence: recipient.sequence ?? 1,
    required: recipient.required ?? recipient.role === "signer",
    metadata: recipient.metadata ?? {},
  }))

  const { data: insertedRecipients, error: insertRecipientsError } = await supabase
    .from("envelope_recipients")
    .insert(recipientRows)
    .select("recipient_type, contact_id, user_id, name, email, role, signer_role, sequence, required")

  if (insertRecipientsError) {
    throw new Error(`Failed to copy envelope recipients: ${insertRecipientsError.message}`)
  }

  const signingRequestsResult = await createEnvelopeSigningRequests(
    {
      envelope_id: createdEnvelope.id,
      expires_at: sourceEnvelope.expires_at ?? undefined,
    },
    orgId,
  )

  const signerNameByRole = new Map(
    normalizedRecipients
      .filter((recipient) => recipient.role === "signer")
      .map((recipient, index) => [recipient.signer_role ?? `signer_${index + 1}`, recipient.name ?? ""]),
  )

  const firstBatch = getNextRequiredSequence((signingRequestsResult.requests ?? []) as SigningRequestRoutingRow[])
  const sendableFirstBatch = (firstBatch ?? []).filter((request) => request.status === "draft" && !!request.sent_to_email)

  await Promise.all(
    sendableFirstBatch.map(async (request) => {
      const link = await issueSigningLinkForRequest(supabase, {
        orgId,
        requestId: request.id,
        markSent: true,
      })

      await sendSignerRequestEmail({
        toEmail: request.sent_to_email as string,
        documentTitle: sourceDocument?.title ?? "Document",
        signingUrl: link.url,
        recipientName: signerNameByRole.get(request.signer_role ?? "") ?? "",
      })
    }),
  )

  const envelopeRecipientsForMetadata = (insertedRecipients ?? []).map((recipient) => ({
    type: recipient.recipient_type,
    name: recipient.name ?? null,
    email: recipient.email ?? null,
    contact_id: recipient.contact_id ?? null,
    user_id: recipient.user_id ?? null,
    role: recipient.role,
    signer_role: recipient.signer_role || null,
    sequence: recipient.sequence ?? null,
    required: recipient.required,
  }))

  const { error: updateDocumentError } = await supabase
    .from("documents")
    .update({
      status: "sent",
      metadata: {
        ...(sourceDocument?.metadata ?? {}),
        envelope_recipients: envelopeRecipientsForMetadata,
        unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
      },
      updated_at: nowIso,
    })
    .eq("org_id", orgId)
    .eq("id", sourceEnvelope.document_id)

  if (updateDocumentError) {
    throw new Error(`Failed to update document after resend: ${updateDocumentError.message}`)
  }

  const { error: markEnvelopeSentError } = await supabase
    .from("envelopes")
    .update({
      status: "sent",
      sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("org_id", orgId)
    .eq("id", createdEnvelope.id)

  if (markEnvelopeSentError) {
    throw new Error(`Failed to mark resend envelope as sent: ${markEnvelopeSentError.message}`)
  }

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: ENVELOPE_EVENT_TYPES.created,
    envelopeId: createdEnvelope.id,
    documentId: sourceEnvelope.document_id,
    payload: {
      source: "documents.resendEnvelopeAction",
      resend_of_envelope_id: sourceEnvelope.id,
      signer_count: signerCount,
    },
  })

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: ENVELOPE_EVENT_TYPES.sent,
    envelopeId: createdEnvelope.id,
    documentId: sourceEnvelope.document_id,
    payload: {
      source: "documents.resendEnvelopeAction",
      resend_of_envelope_id: sourceEnvelope.id,
      sent_now: sendableFirstBatch.length,
      signer_count: signerCount,
    },
  })

  return {
    success: true,
    envelopeId: createdEnvelope.id,
    sentNow: sendableFirstBatch.length,
  }
}

export async function getEnvelopeExecutedDownloadUrlAction(input: { envelopeId: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, org_id, document_id, status")
    .eq("org_id", orgId)
    .eq("id", input.envelopeId)
    .maybeSingle()

  if (envelopeError || !envelope) {
    throw new Error(`Envelope not found: ${envelopeError?.message ?? "missing"}`)
  }
  if (envelope.status !== "executed") {
    throw new Error("Envelope is not executed yet")
  }

  const { data: executedEvent } = await supabase
    .from("events")
    .select("payload")
    .eq("org_id", orgId)
    .eq("entity_type", "envelope")
    .eq("entity_id", envelope.id)
    .eq("event_type", ENVELOPE_EVENT_TYPES.executed)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const payloadFileId =
    typeof executedEvent?.payload?.executed_file_id === "string"
      ? executedEvent.payload.executed_file_id
      : null

  let executedFileId = payloadFileId
  if (!executedFileId) {
    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("id, executed_file_id")
      .eq("org_id", orgId)
      .eq("id", envelope.document_id)
      .maybeSingle()

    if (documentError || !document?.executed_file_id) {
      throw new Error(`Executed file not found: ${documentError?.message ?? "missing"}`)
    }
    executedFileId = document.executed_file_id
  }

  const token = createExecutedFileAccessToken(executedFileId)
  return {
    url: buildExecutedDocumentUrl(token),
    executedFileId,
  }
}

export async function uploadESignDocumentFileAction(projectId: string, formData: FormData) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  if (getFilesStorageProvider() !== "r2") {
    throw new Error("E-sign documents must be stored in R2. Set FILES_STORAGE=r2.")
  }

  const file = formData.get("file") as File
  if (!file) {
    throw new Error("No file provided")
  }

  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(orgId, "projects", projectId, "esign", "source", `${timestamp}_${safeName}`)

  const bytes = Buffer.from(await file.arrayBuffer())
  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes,
    contentType: file.type,
    upsert: false,
  })

  const record = await createFileRecord(
    {
      project_id: projectId,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
      visibility: "private",
      category: "contracts",
      folder_path: `/projects/${projectId}/esign/source`,
      source: "upload",
    },
    orgId,
  )

  await createInitialVersion(
    {
      fileId: record.id,
      storagePath,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    },
    orgId,
  )

  return record
}
