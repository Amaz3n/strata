"use server"

import { createHmac, randomBytes, randomUUID } from "crypto"
import { PDFDocument } from "pdf-lib"

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
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getComplianceRules } from "@/lib/services/compliance"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { SignatureEmail } from "@/lib/emails/signature-email"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  buildOrgScopedPath,
  createFilesUploadUrl,
  downloadFilesObject,
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
  "estimate",
  "proposal",
  "change_order",
  "lien_waiver",
  "selection",
  "subcontract",
  "subcontract_change_order",
  "closeout",
  "other",
]

const CONTRACT_TEMPLATE_SOURCE_TYPES = [
  "estimate",
  "change_order",
  "subcontract",
  "subcontract_change_order",
] as const

type ContractTemplateFor = (typeof CONTRACT_TEMPLATE_SOURCE_TYPES)[number]

const sourceEntityMetadataIdKeyByType: Record<UnifiedSignableEntityType, string> = {
  estimate: "estimate_id",
  proposal: "proposal_id",
  change_order: "change_order_id",
  lien_waiver: "lien_waiver_id",
  selection: "selection_id",
  subcontract: "subcontract_id",
  subcontract_change_order: "subcontract_change_order_id",
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

function getContractTemplateForSourceType(
  sourceEntityType?: UnifiedSignableEntityType | null,
): ContractTemplateFor | null {
  return CONTRACT_TEMPLATE_SOURCE_TYPES.includes(sourceEntityType as ContractTemplateFor)
    ? (sourceEntityType as ContractTemplateFor)
    : null
}

function getSourceEntityCompletionEvent(sourceEntityType: UnifiedSignableEntityType) {
  if (sourceEntityType === "estimate") return completionEventByEntityType.estimate
  if (sourceEntityType === "proposal") return completionEventByEntityType.proposal
  if (sourceEntityType === "change_order") return completionEventByEntityType.change_order
  if (sourceEntityType === "lien_waiver") return completionEventByEntityType.lien_waiver
  if (sourceEntityType === "selection") return completionEventByEntityType.selection
  if (sourceEntityType === "subcontract") return completionEventByEntityType.subcontract
  if (sourceEntityType === "subcontract_change_order") return completionEventByEntityType.subcontract_change_order
  return null
}

async function getSubcontractExecutionCompanyId({
  supabase,
  orgId,
  sourceEntityType,
  sourceEntityId,
}: {
  supabase: any
  orgId: string
  sourceEntityType?: UnifiedSignableEntityType
  sourceEntityId?: string | null
}) {
  if (
    !sourceEntityId ||
    (sourceEntityType !== "subcontract" && sourceEntityType !== "subcontract_change_order")
  ) {
    return null
  }

  if (sourceEntityType === "subcontract") {
    const { data, error } = await supabase
      .from("commitments")
      .select("company_id")
      .eq("org_id", orgId)
      .eq("id", sourceEntityId)
      .maybeSingle()
    if (error) throw new Error(`Failed to validate subcontract compliance: ${error.message}`)
    return data?.company_id ?? null
  }

  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select("company_id, commitment:commitments(company_id)")
    .eq("org_id", orgId)
    .eq("id", sourceEntityId)
    .maybeSingle()
  if (error) throw new Error(`Failed to validate subcontract change order compliance: ${error.message}`)
  const commitment = Array.isArray(data?.commitment) ? data?.commitment[0] : data?.commitment
  return data?.company_id ?? commitment?.company_id ?? null
}

async function getSafeComplianceRules(orgId: string) {
  return getComplianceRules(orgId).catch(() => ({
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
    warn_subcontract_execution_on_missing_docs: true,
    block_subcontract_execution_on_missing_docs: false,
  }))
}

export type SignatureSourceComplianceGate = {
  applies: boolean
  companyId: string | null
  warn: boolean
  block: boolean
  isCompliant: boolean
  missingDocumentNames: string[]
  expiredDocumentNames: string[]
  deficiencyMessages: string[]
  pendingReviewCount: number
}

export async function getSignatureSourceComplianceAction(input: {
  source_entity_type?: UnifiedSignableEntityType | null
  source_entity_id?: string | null
}): Promise<SignatureSourceComplianceGate> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  const sourceEntityType = input.source_entity_type ?? undefined
  const sourceEntityId = input.source_entity_id ?? null
  const applies =
    !!sourceEntityId &&
    (sourceEntityType === "subcontract" || sourceEntityType === "subcontract_change_order")
  const rules = await getSafeComplianceRules(orgId)

  if (!applies) {
    return {
      applies: false,
      companyId: null,
      warn: false,
      block: false,
      isCompliant: true,
      missingDocumentNames: [],
      expiredDocumentNames: [],
      deficiencyMessages: [],
      pendingReviewCount: 0,
    }
  }

  const companyId = await getSubcontractExecutionCompanyId({
    supabase,
    orgId,
    sourceEntityType,
    sourceEntityId,
  })

  if (!companyId) {
    return {
      applies: true,
      companyId: null,
      warn: Boolean(rules.warn_subcontract_execution_on_missing_docs),
      block: Boolean(rules.block_subcontract_execution_on_missing_docs),
      isCompliant: true,
      missingDocumentNames: [],
      expiredDocumentNames: [],
      deficiencyMessages: [],
      pendingReviewCount: 0,
    }
  }

  const status = await getCompanyComplianceStatusWithClient(supabase, orgId, companyId)
  return {
    applies: true,
    companyId,
    warn: Boolean(rules.warn_subcontract_execution_on_missing_docs),
    block: Boolean(rules.block_subcontract_execution_on_missing_docs),
    isCompliant: status.is_compliant,
    missingDocumentNames: status.missing.map((type) => type.name),
    expiredDocumentNames: status.expired.map((document) => document.document_type?.name ?? "Expired document"),
    deficiencyMessages: status.deficiencies.map((deficiency) => deficiency.message),
    pendingReviewCount: status.pending_review.length,
  }
}

async function assertSubcontractExecutionCompliance({
  supabase,
  orgId,
  sourceEntityType,
  sourceEntityId,
}: {
  supabase: any
  orgId: string
  sourceEntityType?: UnifiedSignableEntityType
  sourceEntityId?: string | null
}) {
  if (
    !sourceEntityId ||
    (sourceEntityType !== "subcontract" && sourceEntityType !== "subcontract_change_order")
  ) {
    return
  }

  const rules = await getSafeComplianceRules(orgId)
  if (!rules.block_subcontract_execution_on_missing_docs) return

  const companyId = await getSubcontractExecutionCompanyId({
    supabase,
    orgId,
    sourceEntityType,
    sourceEntityId,
  })

  if (!companyId) return

  const status = await getCompanyComplianceStatusWithClient(supabase, orgId, companyId)
  if (!status.is_compliant) {
    throw new Error("Vendor compliance documents are required before sending this subcontract for signature.")
  }
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
  orgId: string
  toEmail: string
  documentTitle: string
  signingUrl: string
  recipientName?: string
  isReminder?: boolean
}) {
  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase.from("orgs").select("name, logo_url, slug").eq("id", input.orgId).maybeSingle()
  const subject = input.isReminder ? `Reminder: Signature requested - ${input.documentTitle}` : `Signature requested: ${input.documentTitle}`
  const html = await renderEmailTemplate(
    SignatureEmail({
      documentTitle: input.documentTitle,
      signingLink: input.signingUrl,
      recipientName: input.recipientName,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      eventLabel: input.isReminder ? "Signature Reminder" : "Signature Request",
      headline: input.isReminder ? "Signature still needed" : "Document ready for signature",
      bodyText: input.isReminder
        ? "This is a reminder that your signature is still needed."
        : "You have a document ready for signature.",
      detailLabel: "Signature",
      detailText: "Open the document to review all pages, complete required fields, and sign electronically.",
      buttonText: "Review and Sign",
    }),
  )

  await sendEmail({
    to: [input.toEmail],
    subject,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}

export async function listDocumentsAction(projectId?: string) {
  return listDocuments({ projectId })
}

export async function createDocumentAction(input: {
  project_id: string
  document_type: "estimate" | "proposal" | "contract" | "change_order" | "other"
  title: string
  source_file_id: string
  source_entity_type?: UnifiedSignableEntityType
  source_entity_id?: string
  metadata?: Record<string, any>
}) {
  return createDocument(input)
}

export async function createVersionedSourceDocumentDraftAction(input: {
  project_id: string
  document_type: "estimate" | "proposal" | "contract" | "change_order" | "other"
  title: string
  source_file_id: string
  source_entity_type: UnifiedSignableEntityType
  source_entity_id: string
  metadata?: Record<string, any>
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: latestDocument, error: latestError } = await supabase
    .from("documents")
    .select("id, document_type, metadata, created_at")
    .eq("org_id", orgId)
    .eq("source_entity_type", input.source_entity_type)
    .eq("source_entity_id", input.source_entity_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    throw new Error(`Failed to inspect existing document versions: ${latestError.message}`)
  }

  const latestVersion = Number(latestDocument?.metadata?.version_number ?? 0)
  const nextVersionNumber = Number.isFinite(latestVersion) && latestVersion > 0 ? latestVersion + 1 : 1
  const familyKey = `${input.source_entity_type}:${input.source_entity_id}`

  const createdDocument = await createDocument(
    {
      project_id: input.project_id,
      document_type: input.document_type,
      title: input.title,
      source_file_id: input.source_file_id,
      source_entity_type: input.source_entity_type,
      source_entity_id: input.source_entity_id,
      metadata: {
        ...(input.metadata ?? {}),
        version_family_key: familyKey,
        version_number: nextVersionNumber,
        is_current_version: true,
        supersedes_document_id: latestDocument?.id ?? null,
        ...(latestDocument?.document_type && latestDocument.document_type !== input.document_type
          ? { overrides_document_type_from: latestDocument.document_type }
          : {}),
      },
    },
    orgId,
  )

  if (latestDocument?.id) {
    const previousMetadata = {
      ...(latestDocument.metadata ?? {}),
      is_current_version: false,
      superseded_by_document_id: createdDocument.id,
    }

    const { error: previousUpdateError } = await supabase
      .from("documents")
      .update({
        metadata: previousMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .eq("id", latestDocument.id)

    if (previousUpdateError) {
      throw new Error(`Failed to mark prior document version: ${previousUpdateError.message}`)
    }
  }

  return {
    document: createdDocument,
    version_number: nextVersionNumber,
    supersedes_document_id: latestDocument?.id ?? null,
    superseded_document_type: latestDocument?.document_type ?? null,
  }
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

export async function getDraftDocumentByIdAction(documentId: string) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: draftDocument, error: docsError } = await supabase
    .from("documents")
    .select("id, title, document_type, status, source_file_id, source_entity_type, source_entity_id, metadata, created_at")
    .eq("org_id", orgId)
    .eq("id", documentId)
    .eq("status", "draft")
    .maybeSingle()

  if (docsError) {
    throw new Error(`Failed to load draft document: ${docsError.message}`)
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
    throw new Error(`Failed to load draft source file: ${fileResult.error?.message ?? "missing"}`)
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
      source_entity_type: draftDocument.source_entity_type ?? null,
      source_entity_id: draftDocument.source_entity_id ?? null,
    },
    file: fileResult.data,
    fields: fieldsResult,
    recipients: draftRecipients,
    signing_order_enabled: signingOrderEnabled,
  }
}

export async function getSourceEntityVersionContextAction(input: {
  source_entity_type: UnifiedSignableEntityType
  source_entity_id: string
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, document_type, metadata, created_at")
    .eq("org_id", orgId)
    .eq("source_entity_type", input.source_entity_type)
    .eq("source_entity_id", input.source_entity_id)
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) {
    throw new Error(`Failed to load source document versions: ${error.message}`)
  }

  const versions = data ?? []
  const latest = versions[0] ?? null
  const latestVersion = Number(latest?.metadata?.version_number ?? 0)
  const nextVersionNumber = Number.isFinite(latestVersion) && latestVersion > 0 ? latestVersion + 1 : versions.length + 1

  return {
    latest_document_id: latest?.id ?? null,
    latest_document_type: latest?.document_type ?? null,
    latest_document_title: latest?.title ?? null,
    latest_version_number: latestVersion > 0 ? latestVersion : null,
    next_version_number: nextVersionNumber,
    existing_versions_count: versions.length,
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
  source_entity_type?: UnifiedSignableEntityType
  source_entity_id?: string
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

  if ((input.source_entity_type && !input.source_entity_id) || (!input.source_entity_type && input.source_entity_id)) {
    throw new Error("source_entity_type and source_entity_id must be provided together")
  }

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
  const hasSourceEntity = !!input.source_entity_type && !!input.source_entity_id

  if (
    hasSourceEntity &&
    document.source_entity_type &&
    document.source_entity_id &&
    (document.source_entity_type !== input.source_entity_type || document.source_entity_id !== input.source_entity_id)
  ) {
    throw new Error("Draft document is linked to a different source entity")
  }

  const normalizedRecipients = normalizeDraftEnvelopeRecipients(input.recipients ?? [])
  const metadataEntityKey = hasSourceEntity
    ? getSourceEntityMetadataIdKey(input.source_entity_type as UnifiedSignableEntityType)
    : null
  const completionEvent = hasSourceEntity
    ? getSourceEntityCompletionEvent(input.source_entity_type as UnifiedSignableEntityType)
    : null

  const metadata = {
    ...(document.metadata ?? {}),
    ...(metadataEntityKey && input.source_entity_id ? { [metadataEntityKey]: input.source_entity_id } : {}),
    ...(hasSourceEntity
      ? {
          source_entity_type: input.source_entity_type,
          source_entity_id: input.source_entity_id,
        }
      : {}),
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
      ...(hasSourceEntity
        ? {
            source_entity_type: input.source_entity_type,
            source_entity_id: input.source_entity_id,
          }
        : {}),
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
      ...(hasSourceEntity
        ? {
            source_entity_type: input.source_entity_type,
            source_entity_id: input.source_entity_id,
          }
        : {}),
      metadata: {
        ...(metadataEntityKey && input.source_entity_id ? { [metadataEntityKey]: input.source_entity_id } : {}),
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
  expires_at?: string | null
  reminder_enabled?: boolean
  reminder_interval_days?: number | null
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

  await assertSubcontractExecutionCompliance({
    supabase,
    orgId,
    sourceEntityType,
    sourceEntityId,
  })

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
    reminder_settings: {
      enabled: input.reminder_enabled === true,
      interval_days:
        input.reminder_enabled === true
          ? Math.max(1, Math.min(30, Number(input.reminder_interval_days ?? 3) || 3))
          : null,
    },
    unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
  }

  const envelope = await ensureDraftEnvelopeForDocument(
    {
      document_id: document.id,
      source_entity_type: sourceEntityType,
      source_entity_id: sourceEntityId,
      document_revision: document.current_revision ?? 1,
      expires_at: input.expires_at ?? undefined,
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
      expires_at: input.expires_at ?? undefined,
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
        orgId,
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
      expires_at: input.expires_at ?? null,
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
    orgId,
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

export async function createMySigningLinkAction(input: { envelopeId: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })

  const { data: currentUserProfile } = await supabase
    .from("app_users")
    .select("email")
    .eq("id", userId)
    .maybeSingle()
  const currentUserEmail = normalizeEmailForCompare(currentUserProfile?.email ?? null)
  if (!currentUserEmail) {
    throw new Error("Your user profile does not have an email address")
  }

  const { data: requests, error: requestsError } = await supabase
    .from("document_signing_requests")
    .select("id, sequence, required, status, sent_to_email")
    .eq("org_id", orgId)
    .eq("envelope_id", input.envelopeId)
    .order("sequence", { ascending: true })
    .order("created_at", { ascending: true })

  if (requestsError) {
    throw new Error(`Failed to load signing requests: ${requestsError.message}`)
  }

  const nextPending = getNextRequiredSequence((requests ?? []) as SigningRequestRoutingRow[]) ?? []
  const matchingRequest = nextPending.find(
    (request: any) => normalizeEmailForCompare(request.sent_to_email) === currentUserEmail,
  )
  if (!matchingRequest) {
    throw new Error("You are not the current signer for this envelope")
  }

  const link = await issueSigningLinkForRequest(supabase, {
    orgId,
    requestId: matchingRequest.id,
    markSent: matchingRequest.status === "draft",
  })

  await recordESignEvent({
    orgId,
    envelopeId: input.envelopeId,
    eventType: "signing_link_opened_by_sender",
    actorId: userId,
    payload: {
      request_id: matchingRequest.id,
      email: currentUserEmail,
    },
  })

  return { url: link.url }
}

type SignaturesHubRow = {
  envelope_id: string
  document_id: string
  document_title: string
  document_type: string
  document_status: string
  document_metadata: Record<string, any>
  source_file_id: string | null
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
  recipient_statuses: Array<{
    id: string
    name: string
    email: string | null
    signer_role: string | null
    sequence: number
    status: string
    sent_at: string | null
    viewed_at: string | null
    signed_at: string | null
    signed_by_name: string | null
    signed_by_email: string | null
    identity_mismatch: boolean
    is_current: boolean
    can_remind: boolean
  }>
  activity: Array<{
    id: string
    event_type: string
    label: string
    created_at: string
    actor_label: string | null
    detail: string | null
  }>
  last_event_at: string | null
  can_remind: boolean
  can_void: boolean
  can_resend: boolean
  can_download: boolean
  can_delete_draft: boolean
  can_sign_myself: boolean
  can_mark_offline: boolean
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

function normalizeEmailForCompare(value?: string | null) {
  return value?.trim().toLowerCase() ?? ""
}

function getSignatureEventLabel(eventType: string) {
  switch (eventType) {
    case ENVELOPE_EVENT_TYPES.created:
      return "Envelope created"
    case ENVELOPE_EVENT_TYPES.sent:
      return "Envelope sent"
    case ENVELOPE_EVENT_TYPES.viewed:
      return "Signer viewed"
    case ENVELOPE_EVENT_TYPES.recipientSigned:
      return "Signer completed"
    case ENVELOPE_EVENT_TYPES.executed:
      return "Envelope executed"
    case ENVELOPE_EVENT_TYPES.voided:
      return "Envelope voided"
    default:
      return eventType.replaceAll("_", " ")
  }
}

function buildSignatureActivity(event: {
  id?: string | number | null
  event_type?: string | null
  created_at?: string | null
  payload?: Record<string, any> | null
}) {
  const payload = event.payload ?? {}
  const eventType = event.event_type ?? "activity"
  const signerName = typeof payload.signer_name === "string" ? payload.signer_name : null
  const signerEmail =
    typeof payload.submitted_signer_email === "string"
      ? payload.submitted_signer_email
      : typeof payload.signer_email === "string"
      ? payload.signer_email
      : null
  const sentNow = typeof payload.sent_now === "number" ? payload.sent_now : null
  const reason = typeof payload.reason === "string" ? payload.reason : null

  return {
    id: String(event.id ?? `${eventType}-${event.created_at ?? ""}`),
    event_type: eventType,
    label: getSignatureEventLabel(eventType),
    created_at: event.created_at ?? new Date(0).toISOString(),
    actor_label: signerName ?? signerEmail ?? null,
    detail:
      eventType === ENVELOPE_EVENT_TYPES.sent && sentNow
        ? `${sentNow} link${sentNow === 1 ? "" : "s"} sent`
        : reason
        ? reason
        : null,
  }
}

export type SignatureStartTarget = {
  id: string
  type: "proposal" | "change_order" | "selection" | "subcontract" | "subcontract_change_order"
  project_id: string
  project_name: string | null
  title: string
  document_type: "proposal" | "change_order" | "contract" | "other"
}

export type SignatureEnvelopeProject = {
  id: string
  name: string
}

export type ESignTemplateSummary = {
  id: string
  name: string
  description: string | null
  project_id: string | null
  project_name: string | null
  document_type: "estimate" | "proposal" | "contract" | "change_order" | "other"
  source_file_id: string
  source_file_name: string | null
  fields: Array<Record<string, any>>
  recipients: Array<Record<string, any>>
  reminder_settings: Record<string, any>
  created_at: string
}

async function createESignPdfFileRecord(input: {
  supabase: any
  orgId: string
  projectId: string
  fileName: string
  bytes: Buffer | Uint8Array
  storagePath: string
  source?: "upload" | "generated"
  folderPath?: string
  metadata?: Record<string, any>
}) {
  await uploadFilesObject({
    supabase: input.supabase,
    orgId: input.orgId,
    path: input.storagePath,
    bytes: input.bytes,
    contentType: "application/pdf",
    upsert: false,
  })

  const record = await createFileRecord(
    {
      project_id: input.projectId,
      file_name: input.fileName,
      storage_path: input.storagePath,
      mime_type: "application/pdf",
      size_bytes: input.bytes.length,
      visibility: "private",
      category: "contracts",
      folder_path: input.folderPath ?? `/projects/${input.projectId}/esign/source`,
      source: input.source ?? "upload",
    },
    input.orgId,
  )

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    await input.supabase
      .from("files")
      .update({ metadata: input.metadata })
      .eq("org_id", input.orgId)
      .eq("id", record.id)
  }

  void createInitialVersion(
    {
      fileId: record.id,
      storagePath: input.storagePath,
      fileName: input.fileName,
      mimeType: "application/pdf",
      sizeBytes: input.bytes.length,
    },
    input.orgId,
  ).catch((error) => {
    console.error("Failed to create initial file version for e-sign PDF", error)
  })

  return {
    ...record,
    metadata: input.metadata ?? record.metadata,
  }
}

export type ContractTermsTemplateSummary = {
  id: string
  template_for: ContractTemplateFor
  file_name: string
  size_bytes: number | null
}

async function loadContractTermsTemplate(input: {
  supabase: any
  orgId: string
  templateFor: ContractTemplateFor
}) {
  const { data, error } = await input.supabase
    .from("files")
    .select("id, file_name, storage_path, size_bytes, metadata")
    .eq("org_id", input.orgId)
    .is("project_id", null)
    .is("archived_at", null)
    .eq("metadata->>contract_template_for", input.templateFor)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load contract terms template: ${error.message}`)
  }
  return data
}

export async function getContractTermsTemplateForSourceAction(input: {
  source_entity_type?: UnifiedSignableEntityType | null
}): Promise<ContractTermsTemplateSummary | null> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  const templateFor = getContractTemplateForSourceType(input.source_entity_type)
  if (!templateFor) return null

  const template = await loadContractTermsTemplate({ supabase, orgId, templateFor })
  if (!template) return null

  return {
    id: template.id,
    template_for: templateFor,
    file_name: template.file_name,
    size_bytes: template.size_bytes ?? null,
  }
}

export async function applyContractTermsTemplateAction(input: {
  projectId: string
  sourceFileId: string
  sourceEntityType?: UnifiedSignableEntityType | null
  title?: string | null
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const templateFor = getContractTemplateForSourceType(input.sourceEntityType)
  if (!templateFor) {
    throw new Error("Standard terms are not available for this source type.")
  }

  const [template, sourceResult] = await Promise.all([
    loadContractTermsTemplate({ supabase, orgId, templateFor }),
    supabase
      .from("files")
      .select("id, file_name, storage_path, size_bytes")
      .eq("org_id", orgId)
      .eq("project_id", input.projectId)
      .eq("id", input.sourceFileId)
      .maybeSingle(),
  ])

  if (!template) {
    throw new Error("No standard terms template is configured for this source type.")
  }
  if (sourceResult.error || !sourceResult.data) {
    throw new Error(`Source PDF not found: ${sourceResult.error?.message ?? "missing"}`)
  }

  const [termsBytes, exhibitBytes] = await Promise.all([
    downloadFilesObject({ supabase, orgId, path: template.storage_path }),
    downloadFilesObject({ supabase, orgId, path: sourceResult.data.storage_path }),
  ])
  const termsPdf = await PDFDocument.load(termsBytes, { ignoreEncryption: true })
  const exhibitPdf = await PDFDocument.load(exhibitBytes, { ignoreEncryption: true })
  const merged = await PDFDocument.create()

  for (const sourcePdf of [termsPdf, exhibitPdf]) {
    const copiedPages = await merged.copyPages(sourcePdf, sourcePdf.getPageIndices())
    copiedPages.forEach((page) => merged.addPage(page))
  }

  const baseTitle =
    input.title?.trim() ||
    sourceResult.data.file_name.replace(/\.pdf$/i, "") ||
    "Signature packet"
  const fileName = `${baseTitle.replace(/\.pdf$/i, "")} - terms and exhibit.pdf`
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    orgId,
    "projects",
    input.projectId,
    "esign",
    "source",
    `${Date.now()}_${randomUUID()}_${safeName}`,
  )

  return createESignPdfFileRecord({
    supabase,
    orgId,
    projectId: input.projectId,
    fileName,
    bytes: Buffer.from(await merged.save()),
    storagePath,
    source: "generated",
    metadata: {
      exhibit_model_signing: true,
      contract_template_for: templateFor,
      contract_terms_template_file_id: template.id,
      exhibit_source_file_id: sourceResult.data.id,
      merged_page_count: merged.getPageCount(),
      merged_source_files: [
        {
          file_id: template.id,
          file_name: template.file_name,
          role: "standard_terms",
          page_count: termsPdf.getPageCount(),
        },
        {
          file_id: sourceResult.data.id,
          file_name: sourceResult.data.file_name,
          role: "arc_exhibit",
          page_count: exhibitPdf.getPageCount(),
        },
      ],
    },
  })
}

export async function listSignatureEnvelopeProjectsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(500)

  if (error) {
    throw new Error(`Failed to load projects for signatures: ${error.message}`)
  }

  return (data ?? []) as SignatureEnvelopeProject[]
}

export async function listESignTemplatesAction(input?: { projectId?: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  let query = supabase
    .from("esign_templates")
    .select("id, name, description, project_id, document_type, source_file_id, fields, recipients, reminder_settings, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(250)

  if (input?.projectId) {
    query = query.or(`project_id.is.null,project_id.eq.${input.projectId}`)
  }

  const { data: templates, error } = await query
  if (error) {
    throw new Error(`Failed to load e-sign templates: ${error.message}`)
  }

  const projectIds = Array.from(new Set((templates ?? []).map((template) => template.project_id).filter(Boolean)))
  const fileIds = Array.from(new Set((templates ?? []).map((template) => template.source_file_id).filter(Boolean)))

  const [projectsResult, filesResult] = await Promise.all([
    projectIds.length > 0
      ? supabase.from("projects").select("id, name").eq("org_id", orgId).in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    fileIds.length > 0
      ? supabase.from("files").select("id, file_name").eq("org_id", orgId).in("id", fileIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (projectsResult.error) {
    throw new Error(`Failed to load template project names: ${projectsResult.error.message}`)
  }
  if (filesResult.error) {
    throw new Error(`Failed to load template source files: ${filesResult.error.message}`)
  }

  const projectNameById = new Map((projectsResult.data ?? []).map((project) => [project.id, project.name]))
  const fileNameById = new Map((filesResult.data ?? []).map((file) => [file.id, file.file_name]))

  return (templates ?? []).map((template): ESignTemplateSummary => ({
    id: template.id,
    name: template.name,
    description: template.description ?? null,
    project_id: template.project_id ?? null,
    project_name: template.project_id ? projectNameById.get(template.project_id) ?? null : null,
    document_type: template.document_type,
    source_file_id: template.source_file_id,
    source_file_name: fileNameById.get(template.source_file_id) ?? null,
    fields: Array.isArray(template.fields) ? template.fields : [],
    recipients: Array.isArray(template.recipients) ? template.recipients : [],
    reminder_settings: (template.reminder_settings ?? {}) as Record<string, any>,
    created_at: template.created_at,
  }))
}

export async function createESignTemplateFromDocumentAction(input: {
  documentId: string
  name: string
  description?: string | null
  projectScoped?: boolean
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const name = input.name.trim()
  if (!name) {
    throw new Error("Template name is required")
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, project_id, title, document_type, source_file_id, metadata")
    .eq("org_id", orgId)
    .eq("id", input.documentId)
    .maybeSingle()

  if (documentError || !document) {
    throw new Error(`Document not found: ${documentError?.message ?? "missing"}`)
  }

  const fields = await listDocumentFields({ documentId: document.id, revision: 1, orgId })
  if (fields.length === 0) {
    throw new Error("Add fields before saving this envelope as a template")
  }

  const recipients = Array.isArray(document.metadata?.draft_recipients)
    ? document.metadata.draft_recipients
    : Array.isArray(document.metadata?.envelope_recipients)
      ? document.metadata.envelope_recipients
      : []

  const templateFields = fields.map((field: any, index: number) => ({
    page_index: field.page_index,
    field_type: field.field_type,
    label: field.label ?? null,
    required: field.required ?? true,
    signer_role: field.signer_role ?? null,
    x: field.x,
    y: field.y,
    w: field.w,
    h: field.h,
    sort_order: field.sort_order ?? index,
    metadata: field.metadata ?? {},
  }))

  const { data: template, error: templateError } = await supabase
    .from("esign_templates")
    .insert({
      org_id: orgId,
      project_id: input.projectScoped === false ? null : document.project_id,
      name,
      description: input.description?.trim() || null,
      document_type: document.document_type,
      source_file_id: document.source_file_id,
      source_document_id: document.id,
      fields: templateFields,
      recipients,
      reminder_settings: document.metadata?.reminder_settings ?? {},
      metadata: {
        created_from_document_id: document.id,
        created_from_document_title: document.title,
      },
      created_by: userId,
    })
    .select("id")
    .single()

  if (templateError || !template) {
    throw new Error(`Failed to save e-sign template: ${templateError?.message ?? "missing"}`)
  }

  return { success: true, templateId: template.id }
}

async function createDraftDocumentFromTemplate(input: {
  supabase: any
  orgId: string
  projectId: string
  template: any
  title: string
  metadata?: Record<string, any>
}) {
  const document = await createDocument(
    {
      project_id: input.projectId,
      document_type: input.template.document_type,
      title: input.title,
      source_file_id: input.template.source_file_id,
      metadata: {
        ...(input.metadata ?? {}),
        template_id: input.template.id,
        template_name: input.template.name,
        draft_recipients: input.template.recipients ?? [],
        reminder_settings: input.template.reminder_settings ?? {},
        unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
      },
    },
    input.orgId,
  )

  await replaceDocumentFields(
    {
      documentId: document.id,
      revision: 1,
      fields: (Array.isArray(input.template.fields) ? input.template.fields : []).map((field: any, index: number) => ({
        page_index: Number(field.page_index ?? 0),
        field_type: field.field_type,
        label: field.label ?? undefined,
        required: field.required ?? true,
        signer_role: field.signer_role ?? undefined,
        x: Number(field.x),
        y: Number(field.y),
        w: Number(field.w),
        h: Number(field.h),
        sort_order: field.sort_order ?? index,
        metadata: field.metadata ?? {},
      })),
      orgId: input.orgId,
    },
  )

  return document
}

export async function createDraftFromESignTemplateAction(input: {
  templateId: string
  projectId: string
  title?: string
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: template, error } = await supabase
    .from("esign_templates")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", input.templateId)
    .maybeSingle()

  if (error || !template) {
    throw new Error(`Template not found: ${error?.message ?? "missing"}`)
  }
  if (template.project_id && template.project_id !== input.projectId) {
    throw new Error("This template belongs to a different project")
  }

  const title = input.title?.trim() || template.name
  const document = await createDraftDocumentFromTemplate({
    supabase,
    orgId,
    projectId: input.projectId,
    template,
    title,
  })

  return { documentId: document.id }
}

export async function bulkSendTemplateEnvelopesAction(input: {
  templateId: string
  projectId: string
  recipients: Array<{ name?: string; email: string; title?: string }>
  expires_at?: string | null
  reminder_enabled?: boolean
  reminder_interval_days?: number | null
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  if (!input.recipients || input.recipients.length === 0) {
    throw new Error("Add at least one recipient")
  }
  if (input.recipients.length > 100) {
    throw new Error("Bulk send is limited to 100 recipients at a time")
  }

  const { data: template, error } = await supabase
    .from("esign_templates")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", input.templateId)
    .maybeSingle()

  if (error || !template) {
    throw new Error(`Template not found: ${error?.message ?? "missing"}`)
  }
  if (template.project_id && template.project_id !== input.projectId) {
    throw new Error("This template belongs to a different project")
  }

  const results: Array<{ email: string; envelopeId: string | null; error?: string }> = []
  for (const recipient of input.recipients) {
    const email = recipient.email.trim()
    if (!email) continue
    try {
      const document = await createDraftDocumentFromTemplate({
        supabase,
        orgId,
        projectId: input.projectId,
        template,
        title: recipient.title?.trim() || template.name,
        metadata: {
          bulk_send_template_id: template.id,
          bulk_send_recipient_email: email,
        },
      })

      const sendResult = await sendDocumentEnvelopeAction({
        document_id: document.id,
        recipients: [
          {
            type: "external_email",
            role: "signer",
            name: recipient.name?.trim() || email,
            email,
            signer_role: "signer_1",
            sequence: 1,
            required: true,
          },
        ],
        expires_at: input.expires_at ?? null,
        reminder_enabled: input.reminder_enabled,
        reminder_interval_days: input.reminder_interval_days,
      })

      results.push({ email, envelopeId: sendResult.envelopeId })
    } catch (sendError) {
      results.push({
        email,
        envelopeId: null,
        error: sendError instanceof Error ? sendError.message : "Failed to send",
      })
    }
  }

  return {
    success: results.every((result) => !result.error),
    sent: results.filter((result) => !result.error).length,
    failed: results.filter((result) => !!result.error).length,
    results,
  }
}

export async function listSignatureStartTargetsAction(input?: { projectId?: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  let proposalQuery = supabase
    .from("proposals")
    .select("id, project_id, title, status, signature_required")
    .eq("org_id", orgId)
    .eq("signature_required", true)
    .neq("status", "accepted")
    .not("project_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(200)

  let changeOrderQuery = supabase
    .from("change_orders")
    .select("id, project_id, title, status")
    .eq("org_id", orgId)
    .not("project_id", "is", null)
    .in("status", ["draft", "pending", "sent", "requested_changes"])
    .order("updated_at", { ascending: false })
    .limit(200)

  let selectionQuery = supabase
    .from("project_selections")
    .select("id, project_id, status, category_id, selected_option_id")
    .eq("org_id", orgId)
    .not("project_id", "is", null)
    .not("selected_option_id", "is", null)
    .in("status", ["selected", "confirmed", "ordered"])
    .order("updated_at", { ascending: false })
    .limit(200)

  let commitmentQuery = supabase
    .from("commitments")
    .select("id, project_id, company_id, title, status, executed_at")
    .eq("org_id", orgId)
    .not("project_id", "is", null)
    .is("executed_at", null)
    .in("status", ["draft", "approved"])
    .order("updated_at", { ascending: false })
    .limit(200)

  let commitmentChangeOrderQuery = supabase
    .from("commitment_change_orders")
    .select("id, project_id, commitment_id, title, status, executed_file_id")
    .eq("org_id", orgId)
    .not("project_id", "is", null)
    .is("executed_file_id", null)
    .in("status", ["draft", "sent"])
    .order("updated_at", { ascending: false })
    .limit(200)

  if (input?.projectId) {
    proposalQuery = proposalQuery.eq("project_id", input.projectId)
    changeOrderQuery = changeOrderQuery.eq("project_id", input.projectId)
    selectionQuery = selectionQuery.eq("project_id", input.projectId)
    commitmentQuery = commitmentQuery.eq("project_id", input.projectId)
    commitmentChangeOrderQuery = commitmentChangeOrderQuery.eq("project_id", input.projectId)
  }

  const [proposalsResult, changeOrdersResult, selectionsResult, commitmentsResult, commitmentChangeOrdersResult] = await Promise.all([
    proposalQuery,
    changeOrderQuery,
    selectionQuery,
    commitmentQuery,
    commitmentChangeOrderQuery,
  ])

  if (proposalsResult.error) {
    throw new Error(`Failed to load proposal signature targets: ${proposalsResult.error.message}`)
  }
  if (changeOrdersResult.error) {
    throw new Error(`Failed to load change order signature targets: ${changeOrdersResult.error.message}`)
  }
  if (selectionsResult.error) {
    throw new Error(`Failed to load selection signature targets: ${selectionsResult.error.message}`)
  }
  if (commitmentsResult.error) {
    throw new Error(`Failed to load commitment signature targets: ${commitmentsResult.error.message}`)
  }
  if (commitmentChangeOrdersResult.error) {
    throw new Error(`Failed to load commitment change order signature targets: ${commitmentChangeOrdersResult.error.message}`)
  }

  const proposals = proposalsResult.data ?? []
  const changeOrders = changeOrdersResult.data ?? []
  const selections = selectionsResult.data ?? []
  const commitments = commitmentsResult.data ?? []
  const commitmentChangeOrders = commitmentChangeOrdersResult.data ?? []

  const projectIds = Array.from(
    new Set(
      [...proposals, ...changeOrders, ...selections, ...commitments, ...commitmentChangeOrders]
        .map((row: any) => row.project_id as string | null)
        .filter((value): value is string => !!value),
    ),
  )
  const categoryIds = Array.from(
    new Set(
      selections
        .map((row: any) => row.category_id as string | null)
        .filter((value): value is string => !!value),
    ),
  )
  const optionIds = Array.from(
    new Set(
      selections
        .map((row: any) => row.selected_option_id as string | null)
        .filter((value): value is string => !!value),
    ),
  )

  const [projectsResult, categoriesResult, optionsResult] = await Promise.all([
    projectIds.length > 0
      ? supabase.from("projects").select("id, name").eq("org_id", orgId).in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    categoryIds.length > 0
      ? supabase.from("selection_categories").select("id, name").eq("org_id", orgId).in("id", categoryIds)
      : Promise.resolve({ data: [], error: null }),
    optionIds.length > 0
      ? supabase.from("selection_options").select("id, name").eq("org_id", orgId).in("id", optionIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (projectsResult.error) {
    throw new Error(`Failed to load project names for signature targets: ${projectsResult.error.message}`)
  }
  if (categoriesResult.error) {
    throw new Error(`Failed to load selection categories for signature targets: ${categoriesResult.error.message}`)
  }
  if (optionsResult.error) {
    throw new Error(`Failed to load selection options for signature targets: ${optionsResult.error.message}`)
  }

  const projectNameById = new Map<string, string>((projectsResult.data ?? []).map((row) => [row.id, row.name]))
  const categoryNameById = new Map<string, string>((categoriesResult.data ?? []).map((row) => [row.id, row.name]))
  const optionNameById = new Map<string, string>((optionsResult.data ?? []).map((row) => [row.id, row.name]))

  const targets: SignatureStartTarget[] = [
    ...proposals.map((proposal: any) => ({
      id: proposal.id,
      type: "proposal" as const,
      project_id: proposal.project_id,
      project_name: projectNameById.get(proposal.project_id) ?? null,
      title: proposal.title?.trim() || "Proposal",
      document_type: "proposal" as const,
    })),
    ...changeOrders.map((changeOrder: any) => ({
      id: changeOrder.id,
      type: "change_order" as const,
      project_id: changeOrder.project_id,
      project_name: projectNameById.get(changeOrder.project_id) ?? null,
      title: changeOrder.title?.trim() || "Change order",
      document_type: "change_order" as const,
    })),
    ...selections.map((selection: any) => {
      const categoryName = categoryNameById.get(selection.category_id) ?? "Selection"
      const optionName = selection.selected_option_id
        ? optionNameById.get(selection.selected_option_id) ?? null
        : null
      const title = optionName ? `${categoryName} - ${optionName}` : categoryName

      return {
        id: selection.id,
        type: "selection" as const,
        project_id: selection.project_id,
        project_name: projectNameById.get(selection.project_id) ?? null,
        title,
        document_type: "other" as const,
      }
    }),
    ...commitments.map((commitment: any) => ({
      id: commitment.id,
      type: "subcontract" as const,
      project_id: commitment.project_id,
      project_name: projectNameById.get(commitment.project_id) ?? null,
      title: commitment.title?.trim() || "Commitment",
      document_type: "contract" as const,
    })),
    ...commitmentChangeOrders.map((changeOrder: any) => ({
      id: changeOrder.id,
      type: "subcontract_change_order" as const,
      project_id: changeOrder.project_id,
      project_name: projectNameById.get(changeOrder.project_id) ?? null,
      title: changeOrder.title?.trim() || "Subcontract change order",
      document_type: "contract" as const,
    })),
  ]

  targets.sort((a, b) => {
    const projectCompare = (a.project_name ?? "").localeCompare(b.project_name ?? "")
    if (projectCompare !== 0) return projectCompare
    const typeCompare = a.type.localeCompare(b.type)
    if (typeCompare !== 0) return typeCompare
    return a.title.localeCompare(b.title)
  })

  return targets
}

export async function listSignaturesHubAction(input?: { projectId?: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.member", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  let envelopeQuery = supabase
    .from("envelopes")
    .select(
      "id, org_id, project_id, document_id, source_entity_type, source_entity_id, status, sent_at, executed_at, expires_at, voided_at, created_at, metadata, documents!inner(id, title, document_type, status, source_file_id, executed_file_id, metadata)",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(500)

  let draftDocumentsQuery = supabase
    .from("documents")
    .select("id, org_id, project_id, title, document_type, status, source_file_id, source_entity_type, source_entity_id, metadata, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(500)

  if (input?.projectId) {
    envelopeQuery = envelopeQuery.eq("project_id", input.projectId)
    draftDocumentsQuery = draftDocumentsQuery.eq("project_id", input.projectId)
  }

  const [{ data: envelopeRows, error: envelopeError }, { data: draftDocumentRows, error: draftDocumentsError }] =
    await Promise.all([envelopeQuery, draftDocumentsQuery])

  if (envelopeError) {
    throw new Error(`Failed to load signatures hub: ${envelopeError.message}`)
  }
  if (draftDocumentsError) {
    throw new Error(`Failed to load draft documents for signatures hub: ${draftDocumentsError.message}`)
  }

  const envelopes = envelopeRows ?? []
  const draftDocuments = draftDocumentRows ?? []

  const envelopeIds = envelopes.map((row: any) => row.id)
  const projectIds = Array.from(
    new Set(
      [...envelopes.map((row: any) => row.project_id), ...draftDocuments.map((row: any) => row.project_id)].filter(Boolean),
    ),
  )

  const [requestsResult, projectsResult, recipientsResult, envelopeEventsResult] = await Promise.all([
    envelopeIds.length > 0
      ? supabase
          .from("document_signing_requests")
          .select(
            "id, envelope_id, envelope_recipient_id, sequence, required, status, sent_to_email, signer_role, sent_at, viewed_at, signed_at, created_at",
          )
          .eq("org_id", orgId)
          .in("envelope_id", envelopeIds)
          .order("sequence", { ascending: true })
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    projectIds.length > 0
      ? supabase
          .from("projects")
          .select("id, name")
          .eq("org_id", orgId)
          .in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    envelopeIds.length > 0
      ? supabase
          .from("envelope_recipients")
          .select("id, envelope_id, role, name, email, signer_role, sequence, required, created_at")
          .eq("org_id", orgId)
          .in("envelope_id", envelopeIds)
          .eq("role", "signer")
          .order("sequence", { ascending: true })
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    envelopeIds.length > 0
      ? supabase
          .from("events")
          .select("id, entity_id, event_type, payload, created_at")
          .eq("org_id", orgId)
          .eq("entity_type", "envelope")
          .in("entity_id", envelopeIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
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

  const requestIds = (requestsResult.data ?? []).map((request: any) => request.id).filter(Boolean)
  const signaturesResult =
    requestIds.length > 0
      ? await supabase
          .from("document_signatures")
          .select("signing_request_id, signer_name, signer_email, created_at")
          .in("signing_request_id", requestIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null }

  if (signaturesResult.error) {
    throw new Error(`Failed to load signature audit rows for hub: ${signaturesResult.error.message}`)
  }

  const { data: currentUserProfile } = await supabase
    .from("app_users")
    .select("email")
    .eq("id", userId)
    .maybeSingle()
  const currentUserEmail = normalizeEmailForCompare(currentUserProfile?.email ?? null)

  const signatureByRequestId = new Map<
    string,
    { signer_name?: string | null; signer_email?: string | null; created_at?: string | null }
  >()
  for (const signature of signaturesResult.data ?? []) {
    if (!signatureByRequestId.has(signature.signing_request_id)) {
      signatureByRequestId.set(signature.signing_request_id, signature)
    }
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
    Array<{
      id: string
      name: string | null
      email: string | null
      signer_role: string | null
      sequence: number | null
      required: boolean | null
    }>
  >()
  const recipientById = new Map<
    string,
    {
      id: string
      name: string | null
      email: string | null
      signer_role: string | null
      sequence: number | null
      required: boolean | null
    }
  >()
  for (const recipient of recipientsResult.data ?? []) {
    const rows = recipientsByEnvelopeId.get(recipient.envelope_id) ?? []
    const mappedRecipient = {
      id: recipient.id,
      name: recipient.name ?? null,
      email: recipient.email ?? null,
      signer_role: recipient.signer_role ?? null,
      sequence: recipient.sequence ?? null,
      required: recipient.required ?? null,
    }
    rows.push(mappedRecipient)
    recipientsByEnvelopeId.set(recipient.envelope_id, rows)
    recipientById.set(recipient.id, mappedRecipient)
  }
  const latestEventAtByEnvelopeId = new Map<string, string>()
  const activityByEnvelopeId = new Map<string, ReturnType<typeof buildSignatureActivity>[]>()
  for (const event of envelopeEventsResult.data ?? []) {
    const envelopeId = event.entity_id
    if (!envelopeId) continue
    if (!latestEventAtByEnvelopeId.has(envelopeId)) {
      latestEventAtByEnvelopeId.set(envelopeId, event.created_at)
    }
    const rows = activityByEnvelopeId.get(envelopeId) ?? []
    rows.push(buildSignatureActivity(event))
    activityByEnvelopeId.set(envelopeId, rows)
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
      signer_role?: string | null
      sent_at?: string | null
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
          return recipientById.get(request.envelope_recipient_id)?.name?.trim() ?? ""
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

    const recipientStatuses = requiredRequests.map((request, index) => {
      const recipient = request.envelope_recipient_id ? recipientById.get(request.envelope_recipient_id) : null
      const signature = signatureByRequestId.get(request.id)
      const email = request.sent_to_email?.trim() || recipient?.email?.trim() || null
      const signedByEmail = signature?.signer_email?.trim() || null
      const signedAt = request.signed_at ?? signature?.created_at ?? null
      const status = request.status ?? "draft"
      return {
        id: request.id,
        name:
          recipient?.name?.trim() ||
          signature?.signer_name?.trim() ||
          email ||
          `Signer ${index + 1}`,
        email,
        signer_role: request.signer_role ?? recipient?.signer_role ?? null,
        sequence: request.sequence ?? 1,
        status,
        sent_at: request.sent_at ?? null,
        viewed_at: request.viewed_at ?? null,
        signed_at: signedAt,
        signed_by_name: signature?.signer_name?.trim() || null,
        signed_by_email: signedByEmail,
        identity_mismatch:
          status === "signed" &&
          !!email &&
          !!signedByEmail &&
          normalizeEmailForCompare(email) !== normalizeEmailForCompare(signedByEmail),
        is_current: nextPendingRequests.some((pendingRequest) => pendingRequest.id === request.id),
        can_remind:
          !!email &&
          nextPendingRequests.some((pendingRequest) => pendingRequest.id === request.id) &&
          status !== "signed" &&
          status !== "voided" &&
          status !== "expired",
      }
    })

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
    const canSignMyself =
      !!currentUserEmail &&
      nextPendingRequests.some((request) => normalizeEmailForCompare(request.sent_to_email) === currentUserEmail)

    return {
      envelope_id: envelope.id,
      document_id: envelope.document_id,
      document_title: document.title ?? "Document",
      document_type: document.document_type ?? "other",
      document_status: document.status ?? envelope.status,
      document_metadata: (document.metadata ?? {}) as Record<string, any>,
      source_file_id: document.source_file_id ?? null,
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
      recipient_statuses: recipientStatuses,
      activity: activityByEnvelopeId.get(envelope.id) ?? [],
      last_event_at:
        latestEventAtByEnvelopeId.get(envelope.id) ??
        requiredRequests
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
      can_delete_draft: envelope.status === "draft" && (document.status ?? envelope.status) === "draft",
      can_sign_myself: canSignMyself,
      can_mark_offline:
        envelope.status !== "draft" &&
        envelope.status !== "executed" &&
        envelope.status !== "voided" &&
        envelope.status !== "expired",
      queue_flags: {
        waiting_on_client: waitingOnClient,
        executed_this_week: executedThisWeek,
        expiring_soon: expiringSoon,
      },
    }
  })

  const envelopeDocumentIds = new Set(envelopes.map((envelope: any) => envelope.document_id))
  const draftOnlyRows: SignaturesHubRow[] = draftDocuments
    .filter((document: any) => !envelopeDocumentIds.has(document.id))
    .map((document: any) => {
      const draftRecipients = Array.isArray(document.metadata?.draft_recipients)
        ? (document.metadata.draft_recipients as Array<{ role?: string; name?: string; email?: string }>)
        : []

      const draftRecipientNames = draftRecipients
        .filter((recipient) => recipient.role === "signer")
        .map((recipient) => recipient.name?.trim() || recipient.email?.trim() || "")
        .filter((value) => value.length > 0)

      return {
        envelope_id: `draft-${document.id}`,
        document_id: document.id,
        document_title: document.title ?? "Document",
        document_type: document.document_type ?? "other",
        document_status: document.status ?? "draft",
        document_metadata: (document.metadata ?? {}) as Record<string, any>,
        source_file_id: document.source_file_id ?? null,
        project_id: document.project_id,
        project_name: projectNameById.get(document.project_id) ?? null,
        source_entity_type: document.source_entity_type ?? null,
        source_entity_id: document.source_entity_id ?? null,
        envelope_status: "draft",
        created_at: document.created_at,
        sent_at: null,
        executed_at: null,
        expires_at: null,
        voided_at: null,
        signer_summary: {
          total: 0,
          signed: 0,
          viewed: 0,
          pending: 0,
        },
        next_pending_request_id: null,
        next_pending_sequence: null,
        next_pending_emails: [],
        recipient_names: draftRecipientNames,
        next_pending_names: [],
        recipient_statuses: draftRecipientNames.map((name, index) => ({
          id: `${document.id}-draft-recipient-${index}`,
          name,
          email: null,
          signer_role: null,
          sequence: index + 1,
          status: "draft",
          sent_at: null,
          viewed_at: null,
          signed_at: null,
          signed_by_name: null,
          signed_by_email: null,
          identity_mismatch: false,
          is_current: false,
          can_remind: false,
        })),
        activity: [
          {
            id: `${document.id}-draft-created`,
            event_type: "draft_created",
            label: "Draft created",
            created_at: document.created_at,
            actor_label: null,
            detail: null,
          },
        ],
        last_event_at: document.updated_at ?? document.created_at ?? null,
        can_remind: false,
        can_void: false,
        can_resend: false,
        can_download: false,
        can_delete_draft: true,
        can_sign_myself: false,
        can_mark_offline: false,
        queue_flags: {
          waiting_on_client: false,
          executed_this_week: false,
          expiring_soon: false,
        },
      }
    })

  rows.push(...draftOnlyRows)
  rows.sort((a, b) => new Date(b.last_event_at ?? b.created_at).getTime() - new Date(a.last_event_at ?? a.created_at).getTime())

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
    .select("id, org_id, document_id, status, metadata, documents!inner(title)")
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

  const documentForVoid = Array.isArray((envelope as any).documents)
    ? (envelope as any).documents[0]
    : (envelope as any).documents

  const { data: activeRequestsForNotice } = await supabase
    .from("document_signing_requests")
    .select("sent_to_email")
    .eq("org_id", orgId)
    .eq("envelope_id", envelope.id)
    .in("status", ["draft", "sent", "viewed"])

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

  try {
    const emails = Array.from(
      new Set(
        (activeRequestsForNotice ?? [])
          .map((request) => request.sent_to_email?.trim())
          .filter((email): email is string => !!email),
      ),
    )

    if (emails.length > 0) {
      const { data: org } = await supabase.from("orgs").select("name, logo_url, slug").eq("id", orgId).maybeSingle()
      const html = await renderEmailTemplate(
        SignatureEmail({
          documentTitle: documentForVoid?.title ?? "Document",
          signingLink: "#",
          orgName: org?.name ?? null,
          orgLogoUrl: org?.logo_url ?? null,
          eventLabel: "Signature Withdrawn",
          headline: "Signature request withdrawn",
          bodyText: `${documentForVoid?.title ?? "This document"} is no longer available for signature.`,
          detailLabel: "Status",
          detailText: input.reason?.trim()
            ? `The request was withdrawn: ${input.reason.trim()}`
            : "The request was withdrawn by the sender. Please contact them if you need a new link.",
          buttonText: "Request withdrawn",
          previewText: `Signature request withdrawn: ${documentForVoid?.title ?? "Document"}`,
        }),
      )

      await Promise.all(
        emails.map((email) =>
          sendEmail({
            to: [email],
            subject: `Signature request withdrawn: ${documentForVoid?.title ?? "Document"}`,
            html,
            from: getOrgSenderEmail(org?.slug, org?.name),
          }),
        ),
      )
    }
  } catch (noticeError) {
    console.error("Failed to notify signers after voiding envelope", {
      envelopeId: envelope.id,
      error: noticeError instanceof Error ? noticeError.message : String(noticeError),
    })
  }

  return { success: true, idempotent: false }
}

export async function markEnvelopeSignedOfflineAction(input: { envelopeId: string; formData: FormData }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const file = input.formData.get("file") as File | null
  const signerName = String(input.formData.get("signer_name") ?? "").trim() || "Wet-ink signer"
  const note = String(input.formData.get("note") ?? "").trim() || null
  if (!file || file.size <= 0) throw new Error("Upload the signed PDF")
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Offline signed copy must be a PDF")
  }

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, org_id, project_id, document_id, source_entity_type, source_entity_id, status, metadata, documents!inner(id, title, source_file_id, metadata)")
    .eq("org_id", orgId)
    .eq("id", input.envelopeId)
    .maybeSingle()

  if (envelopeError || !envelope) {
    throw new Error(`Envelope not found: ${envelopeError?.message ?? "missing"}`)
  }
  if (envelope.status === "executed") return { success: true, idempotent: true }
  if (envelope.status === "voided" || envelope.status === "expired") {
    throw new Error("This envelope can no longer be marked signed")
  }

  const document = Array.isArray((envelope as any).documents)
    ? (envelope as any).documents[0]
    : (envelope as any).documents
  const nowIso = new Date().toISOString()
  const fileName = file.name.toLowerCase().endsWith(".pdf") ? file.name : `${file.name}.pdf`
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    orgId,
    "projects",
    envelope.project_id,
    "esign",
    envelope.document_id,
    "executed-offline",
    `${Date.now()}_${randomUUID()}_${safeName}`,
  )
  const bytes = Buffer.from(await file.arrayBuffer())

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes,
    contentType: "application/pdf",
    upsert: false,
  })

  const { data: executedFile, error: executedFileError } = await supabase
    .from("files")
    .insert({
      org_id: orgId,
      project_id: envelope.project_id,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: bytes.length,
      visibility: "private",
      category: "contracts",
      folder_path: `/projects/${envelope.project_id}/esign/executed`,
      source: "upload",
      uploaded_by: userId,
      share_with_clients: false,
      share_with_subs: false,
      metadata: {
        offline_execution: true,
        source_file_id: document?.source_file_id ?? null,
        envelope_id: envelope.id,
        document_id: envelope.document_id,
        note,
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
      org_id: orgId,
      file_id: executedFile.id,
      version_number: 1,
      label: "Executed offline",
      notes: note,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: "application/pdf",
      size_bytes: bytes.length,
      created_by: userId,
    })
    .select("id")
    .single()

  if (versionError || !version) {
    throw new Error(`Failed to create executed file version: ${versionError?.message}`)
  }

  await supabase.from("files").update({ current_version_id: version.id }).eq("id", executedFile.id)

  const offlineExecution = {
    executed_file_id: executedFile.id,
    uploaded_by: userId,
    signer_name: signerName,
    note,
    recorded_at: nowIso,
  }
  const envelopeMetadata = {
    ...(envelope.metadata ?? {}),
    offline_execution: offlineExecution,
  }

  const [{ error: documentUpdateError }, { error: envelopeUpdateError }, { error: requestsUpdateError }] =
    await Promise.all([
      supabase
        .from("documents")
        .update({
          status: "signed",
          executed_file_id: executedFile.id,
          metadata: {
            ...(document?.metadata ?? {}),
            offline_execution: offlineExecution,
            unified_esign_phase: UNIFIED_ESIGN_PHASE0_VERSION,
          },
          updated_at: nowIso,
        })
        .eq("org_id", orgId)
        .eq("id", envelope.document_id),
      supabase
        .from("envelopes")
        .update({
          status: "executed",
          executed_at: nowIso,
          metadata: envelopeMetadata,
          updated_at: nowIso,
        })
        .eq("org_id", orgId)
        .eq("id", envelope.id),
      supabase
        .from("document_signing_requests")
        .update({ status: "signed", signed_at: nowIso })
        .eq("org_id", orgId)
        .eq("envelope_id", envelope.id)
        .neq("status", "signed"),
    ])

  if (documentUpdateError) throw new Error(`Failed to update document: ${documentUpdateError.message}`)
  if (envelopeUpdateError) throw new Error(`Failed to update envelope: ${envelopeUpdateError.message}`)
  if (requestsUpdateError) throw new Error(`Failed to update signing requests: ${requestsUpdateError.message}`)

  await recordESignEvent({
    supabase,
    orgId,
    actorId: userId,
    eventType: "offline_executed",
    envelopeId: envelope.id,
    documentId: envelope.document_id,
    payload: {
      source: "signatures.markEnvelopeSignedOfflineAction",
      executed_file_id: executedFile.id,
      signer_name: signerName,
      note,
    },
  })

  await enqueueOutboxJob({
    orgId,
    jobType: "process_esign_execution_side_effects",
    payload: {
      document_id: envelope.document_id,
      envelope_id: envelope.id,
      executed_file_id: executedFile.id,
      signer_name: signerName,
      signer_email: null,
      signer_ip: null,
    },
    dedupeByPayloadKeys: ["executed_file_id"],
  })

  return { success: true, idempotent: false, executedFileId: executedFile.id }
}

export async function deleteDraftDocumentAction(input: { documentId: string }) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })
  await assertUnifiedESignEnabled({ supabase, orgId })

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, org_id, status")
    .eq("org_id", orgId)
    .eq("id", input.documentId)
    .maybeSingle()

  if (documentError || !document) {
    throw new Error(`Document not found: ${documentError?.message ?? "missing"}`)
  }

  if (document.status !== "draft") {
    throw new Error("Only draft documents can be deleted")
  }

  const { data: activeEnvelope, error: activeEnvelopeError } = await supabase
    .from("envelopes")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("document_id", document.id)
    .neq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (activeEnvelopeError) {
    throw new Error(`Failed to validate draft document envelopes: ${activeEnvelopeError.message}`)
  }

  if (activeEnvelope?.id) {
    throw new Error("Cannot delete a draft document with non-draft envelope activity")
  }

  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("org_id", orgId)
    .eq("id", document.id)

  if (deleteError) {
    throw new Error(`Failed to delete draft document: ${deleteError.message}`)
  }

  return { success: true }
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
        orgId,
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

  // Keep upload latency low for e-sign setup; version bookkeeping can complete asynchronously.
  void createInitialVersion(
    {
      fileId: record.id,
      storagePath,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    },
    orgId,
  ).catch((error) => {
    console.error("Failed to create initial file version for e-sign upload", error)
  })

  return record
}

export async function mergeESignPdfUploadAction(projectId: string, formData: FormData) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  if (getFilesStorageProvider() !== "r2") {
    throw new Error("E-sign documents must be stored in R2. Set FILES_STORAGE=r2.")
  }

  const files = formData
    .getAll("files")
    .filter((item): item is File => item instanceof File && item.size > 0)

  if (files.length < 2) {
    throw new Error("Select at least two PDFs to merge")
  }
  if (files.length > 20) {
    throw new Error("Merge is limited to 20 PDFs at a time")
  }

  const merged = await PDFDocument.create()
  const sourceFiles: Array<{ file_name: string; size_bytes: number; page_count: number }> = []

  for (const file of files) {
    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf")
    if (!isPdf) {
      throw new Error(`${file.name} is not a PDF`)
    }

    const sourcePdf = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
    const pageIndexes = sourcePdf.getPageIndices()
    const copiedPages = await merged.copyPages(sourcePdf, pageIndexes)
    copiedPages.forEach((page) => merged.addPage(page))
    sourceFiles.push({
      file_name: file.name,
      size_bytes: file.size,
      page_count: pageIndexes.length,
    })
  }

  const mergedBytes = Buffer.from(await merged.save())
  const baseName =
    String(formData.get("file_name") ?? "").trim() ||
    `${files[0].name.replace(/\.pdf$/i, "")} packet.pdf`
  const fileName = baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    orgId,
    "projects",
    projectId,
    "esign",
    "source",
    `${Date.now()}_${randomUUID()}_${safeName}`,
  )

  const record = await createESignPdfFileRecord({
    supabase,
    orgId,
    projectId,
    fileName,
    bytes: mergedBytes,
    storagePath,
    metadata: {
      merged_esign_source: true,
      merged_source_files: sourceFiles,
      merged_page_count: merged.getPageCount(),
    },
  })

  return record
}

export async function createESignDocumentUploadUrlAction(input: {
  projectId: string
  fileName: string
  fileType: string
  fileSize: number
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  if (getFilesStorageProvider() !== "r2") {
    throw new Error("E-sign documents must be stored in R2. Set FILES_STORAGE=r2.")
  }

  const safeName = input.fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  const uploadId = randomUUID()
  const storagePath = buildOrgScopedPath(
    orgId,
    "projects",
    input.projectId,
    "esign",
    "source",
    `${Date.now()}_${uploadId}_${safeName}`,
  )

  const { uploadUrl } = await createFilesUploadUrl({
    supabase,
    orgId,
    path: storagePath,
    contentType: input.fileType || "application/pdf",
    cacheControl: "private, max-age=31536000",
    expiresIn: 600,
  })

  const uploadToken = createHmac("sha256", requireDocumentSigningSecret())
    .update(
      JSON.stringify({
        projectId: input.projectId,
        storagePath,
        fileName: input.fileName,
        fileType: input.fileType || "application/pdf",
        fileSize: input.fileSize,
      }),
    )
    .digest("hex")

  return {
    uploadUrl,
    storagePath,
    uploadToken,
  }
}

export async function completeESignDocumentUploadAction(input: {
  projectId: string
  storagePath: string
  uploadToken: string
  fileName: string
  fileType: string
  fileSize: number
}) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("project.manage", { supabase, orgId, userId })

  if (getFilesStorageProvider() !== "r2") {
    throw new Error("E-sign documents must be stored in R2. Set FILES_STORAGE=r2.")
  }

  const normalizedType = input.fileType || "application/pdf"
  const expectedToken = createHmac("sha256", requireDocumentSigningSecret())
    .update(
      JSON.stringify({
        projectId: input.projectId,
        storagePath: input.storagePath,
        fileName: input.fileName,
        fileType: normalizedType,
        fileSize: input.fileSize,
      }),
    )
    .digest("hex")

  if (expectedToken !== input.uploadToken) {
    throw new Error("Invalid upload token")
  }

  const record = await createFileRecord(
    {
      project_id: input.projectId,
      file_name: input.fileName,
      storage_path: input.storagePath,
      mime_type: normalizedType,
      size_bytes: input.fileSize,
      visibility: "private",
      category: "contracts",
      folder_path: `/projects/${input.projectId}/esign/source`,
      source: "upload",
    },
    orgId,
  )

  void createInitialVersion(
    {
      fileId: record.id,
      storagePath: input.storagePath,
      fileName: input.fileName,
      mimeType: normalizedType,
      sizeBytes: input.fileSize,
    },
    orgId,
  ).catch((error) => {
    console.error("Failed to create initial file version for e-sign upload", error)
  })

  return record
}
