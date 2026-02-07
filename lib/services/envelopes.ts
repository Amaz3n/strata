import { createHmac, randomBytes } from "crypto"

import type { EnvelopeRecipientType, EnvelopeRecipientRole } from "@/lib/esign/unified-contracts"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  envelopeCreateInputSchema,
  envelopeRecipientInputSchema,
  envelopeSigningRequestCreateInputSchema,
} from "@/lib/validation/documents"

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }
  return secret
}

export type EnvelopeRecipientInput = {
  recipient_type: EnvelopeRecipientType
  contact_id?: string
  user_id?: string
  name?: string
  email?: string
  role: EnvelopeRecipientRole
  signer_role?: string
  sequence?: number
  required?: boolean
  metadata?: Record<string, any>
}

export async function ensureDraftEnvelopeForDocument(
  input: {
    document_id: string
    source_entity_type?: string
    source_entity_id?: string
    document_revision?: number
    subject?: string
    message?: string
    expires_at?: string
    metadata?: Record<string, any>
  },
  orgId?: string,
) {
  const parsed = envelopeCreateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, org_id, project_id, current_revision, source_entity_type, source_entity_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.document_id)
    .maybeSingle()

  if (documentError || !document) {
    throw new Error(`Document not found: ${documentError?.message ?? "missing"}`)
  }

  const { data: existingDraft, error: draftError } = await supabase
    .from("envelopes")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("document_id", document.id)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (draftError) {
    throw new Error(`Failed to load draft envelope: ${draftError.message}`)
  }

  const updatePayload = {
    document_revision: parsed.document_revision ?? document.current_revision ?? 1,
    source_entity_type: parsed.source_entity_type ?? document.source_entity_type ?? null,
    source_entity_id: parsed.source_entity_id ?? document.source_entity_id ?? null,
    subject: parsed.subject ?? null,
    message: parsed.message ?? null,
    expires_at: parsed.expires_at ?? null,
    metadata: parsed.metadata ?? {},
    updated_at: new Date().toISOString(),
  }

  if (existingDraft) {
    const { data: updated, error: updateError } = await supabase
      .from("envelopes")
      .update(updatePayload)
      .eq("org_id", resolvedOrgId)
      .eq("id", existingDraft.id)
      .select("*")
      .single()

    if (updateError || !updated) {
      throw new Error(`Failed to update draft envelope: ${updateError?.message ?? "missing"}`)
    }

    return updated
  }

  const { data: created, error: createError } = await supabase
    .from("envelopes")
    .insert({
      org_id: resolvedOrgId,
      project_id: document.project_id,
      document_id: document.id,
      status: "draft",
      created_by: userId,
      ...updatePayload,
    })
    .select("*")
    .single()

  if (createError || !created) {
    throw new Error(`Failed to create draft envelope: ${createError?.message ?? "missing"}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "envelope",
    entityId: created.id,
    after: created,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "envelope_draft_created",
    entityType: "envelope",
    entityId: created.id,
    payload: {
      document_id: document.id,
      project_id: document.project_id,
    },
  })

  return created
}

export async function replaceEnvelopeRecipients(
  input: {
    envelope_id: string
    recipients: EnvelopeRecipientInput[]
  },
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, org_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", input.envelope_id)
    .maybeSingle()

  if (envelopeError || !envelope) {
    throw new Error(`Envelope not found: ${envelopeError?.message ?? "missing"}`)
  }

  if (envelope.status !== "draft") {
    throw new Error("Only draft envelopes can be updated")
  }

  const parsedRecipients = (input.recipients ?? []).map((recipient) => envelopeRecipientInputSchema.parse(recipient))

  const { error: deleteError } = await supabase
    .from("envelope_recipients")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("envelope_id", envelope.id)

  if (deleteError) {
    throw new Error(`Failed to clear envelope recipients: ${deleteError.message}`)
  }

  if (parsedRecipients.length === 0) {
    return []
  }

  const rows = parsedRecipients.map((recipient, index) => ({
    org_id: resolvedOrgId,
    envelope_id: envelope.id,
    recipient_type: recipient.recipient_type,
    contact_id: recipient.contact_id ?? null,
    user_id: recipient.user_id ?? null,
    name: recipient.name ?? null,
    email: recipient.email ?? null,
    role: recipient.role,
    signer_role: recipient.signer_role ?? null,
    sequence: recipient.sequence ?? index + 1,
    required: recipient.required ?? recipient.role === "signer",
    metadata: recipient.metadata ?? {},
  }))

  const { data: inserted, error: insertError } = await supabase
    .from("envelope_recipients")
    .insert(rows)
    .select("*")

  if (insertError) {
    throw new Error(`Failed to save envelope recipients: ${insertError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "envelope",
    entityId: envelope.id,
    after: { recipients: rows },
  })

  return inserted ?? []
}

export async function createEnvelopeSigningRequests(
  input: {
    envelope_id: string
    max_uses?: number
    expires_at?: string
  },
  orgId?: string,
) {
  const parsed = envelopeSigningRequestCreateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .select("id, org_id, document_id, document_revision, status, expires_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.envelope_id)
    .maybeSingle()

  if (envelopeError || !envelope) {
    throw new Error(`Envelope not found: ${envelopeError?.message ?? "missing"}`)
  }
  if (envelope.status !== "draft") {
    throw new Error("Only draft envelopes can generate signing requests")
  }

  const { data: recipients, error: recipientsError } = await supabase
    .from("envelope_recipients")
    .select("id, contact_id, email, signer_role, sequence, required, role")
    .eq("org_id", resolvedOrgId)
    .eq("envelope_id", envelope.id)
    .eq("role", "signer")
    .order("sequence", { ascending: true })

  if (recipientsError) {
    throw new Error(`Failed to load envelope recipients: ${recipientsError.message}`)
  }

  if (!recipients || recipients.length === 0) {
    throw new Error("At least one signer recipient is required")
  }

  const { data: existingRequests, error: existingRequestsError } = await supabase
    .from("document_signing_requests")
    .select("id, status")
    .eq("org_id", resolvedOrgId)
    .eq("envelope_id", envelope.id)

  if (existingRequestsError) {
    throw new Error(`Failed to load existing signing requests: ${existingRequestsError.message}`)
  }

  const hasNonDraftRequests = (existingRequests ?? []).some((request) => request.status !== "draft")
  if (hasNonDraftRequests) {
    throw new Error("Cannot regenerate signing requests for a non-draft envelope")
  }

  if ((existingRequests ?? []).length > 0) {
    const { error: deleteError } = await supabase
      .from("document_signing_requests")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("envelope_id", envelope.id)
      .eq("status", "draft")

    if (deleteError) {
      throw new Error(`Failed to clear draft signing requests: ${deleteError.message}`)
    }
  }

  const tokenRows = recipients.map((recipient, index) => {
    const token = randomBytes(32).toString("hex")
    const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
    return {
      org_id: resolvedOrgId,
      document_id: envelope.document_id,
      revision: envelope.document_revision,
      token_hash: tokenHash,
      status: "draft",
      recipient_contact_id: recipient.contact_id ?? null,
      sent_to_email: recipient.email ?? null,
      expires_at: parsed.expires_at ?? envelope.expires_at ?? null,
      max_uses: parsed.max_uses ?? 1,
      signer_role: recipient.signer_role ?? `signer_${index + 1}`,
      sequence: recipient.sequence ?? index + 1,
      required: recipient.required !== false,
      group_id: envelope.id,
      envelope_id: envelope.id,
      envelope_recipient_id: recipient.id,
      created_by: userId,
    }
  })

  const { data: requests, error: insertError } = await supabase
    .from("document_signing_requests")
    .insert(tokenRows)
    .select("*")

  if (insertError) {
    throw new Error(`Failed to create signing requests: ${insertError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "document_signing_request",
    entityId: envelope.id,
    after: { envelope_id: envelope.id, request_count: tokenRows.length },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "envelope_signing_requests_created",
    entityType: "envelope",
    entityId: envelope.id,
    payload: { request_count: tokenRows.length, document_id: envelope.document_id },
  })

  return {
    envelope,
    requests: requests ?? [],
  }
}
