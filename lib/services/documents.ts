import { createHmac, randomBytes, randomUUID } from "crypto"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  documentCreateInputSchema,
  documentFieldInputSchema,
  documentSigningRequestInputSchema,
  documentSigningGroupInputSchema,
} from "@/lib/validation/documents"

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }
  return secret
}

export async function createDocument(
  input: {
    project_id: string
    document_type: "proposal" | "contract" | "change_order" | "other"
    title: string
    source_file_id: string
    source_entity_type?: "proposal" | "change_order" | "lien_waiver" | "selection" | "subcontract" | "closeout" | "other"
    source_entity_id?: string
    metadata?: Record<string, any>
  },
  orgId?: string,
) {
  const parsed = documentCreateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: document, error } = await supabase
    .from("documents")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      document_type: parsed.document_type,
      title: parsed.title,
      status: "draft",
      source_file_id: parsed.source_file_id,
      source_entity_type: parsed.source_entity_type ?? null,
      source_entity_id: parsed.source_entity_id ?? null,
      metadata: parsed.metadata ?? {},
      created_by: userId,
    })
    .select("*")
    .single()

  if (error || !document) {
    throw new Error(`Failed to create document: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "document",
    entityId: document.id,
    after: document,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "document_created",
    entityType: "document",
    entityId: document.id,
    payload: { project_id: document.project_id, document_type: document.document_type },
  })

  return document
}

export async function listDocuments({
  projectId,
  orgId,
}: {
  projectId?: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase
    .from("documents")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list documents: ${error.message}`)
  }

  return data ?? []
}

export async function createDocumentSigningRequest(
  input: {
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
  },
  orgId?: string,
) {
  const parsed = documentSigningRequestInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: document, error: docError } = await supabase
    .from("documents")
    .select("id, org_id, project_id, current_revision")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.document_id)
    .single()

  if (docError || !document) {
    throw new Error(`Document not found: ${docError?.message}`)
  }

  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
  const groupId = parsed.group_id ?? parsed.envelope_id ?? randomUUID()

  const { data: signingRequest, error } = await supabase
    .from("document_signing_requests")
    .insert({
      org_id: resolvedOrgId,
      document_id: document.id,
      revision: document.current_revision ?? 1,
      token_hash: tokenHash,
      status: "draft",
      recipient_contact_id: parsed.recipient_contact_id ?? null,
      sent_to_email: parsed.sent_to_email ?? null,
      expires_at: parsed.expires_at ?? null,
      max_uses: parsed.max_uses ?? 1,
      signer_role: parsed.signer_role ?? "client",
      sequence: parsed.sequence ?? 1,
      required: parsed.required ?? true,
      group_id: groupId,
      envelope_id: parsed.envelope_id ?? groupId,
      envelope_recipient_id: parsed.envelope_recipient_id ?? null,
      created_by: userId,
    })
    .select("*")
    .single()

  if (error || !signingRequest) {
    throw new Error(`Failed to create signing request: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "document_signing_request",
    entityId: signingRequest.id,
    after: signingRequest,
  })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const viewUrl = appUrl ? `${appUrl}/d/${token}` : `/d/${token}`

  return {
    signingRequest,
    token,
    url: viewUrl,
  }
}

export async function createDocumentSigningGroup(
  input: {
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
  },
  orgId?: string,
) {
  const parsed = documentSigningGroupInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: document, error: docError } = await supabase
    .from("documents")
    .select("id, org_id, project_id, current_revision")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.document_id)
    .single()

  if (docError || !document) {
    throw new Error(`Document not found: ${docError?.message}`)
  }

  const groupId = parsed.envelope_id ?? randomUUID()
  const tokens = parsed.signers.map(() => randomBytes(32).toString("hex"))
  const tokenHashes = tokens.map((token) =>
    createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex"),
  )

  const rows = parsed.signers.map((signer, index) => ({
    org_id: resolvedOrgId,
    document_id: document.id,
    revision: document.current_revision ?? 1,
    token_hash: tokenHashes[index],
    status: "draft",
    recipient_contact_id: signer.recipient_contact_id ?? null,
    sent_to_email: signer.sent_to_email ?? null,
    expires_at: signer.expires_at ?? null,
    max_uses: signer.max_uses ?? 1,
    signer_role: signer.signer_role,
    sequence: signer.sequence ?? index + 1,
    required: signer.required ?? true,
    group_id: groupId,
    envelope_id: parsed.envelope_id ?? groupId,
    envelope_recipient_id: signer.envelope_recipient_id ?? null,
    created_by: userId,
  }))

  const { data: signingRequests, error } = await supabase
    .from("document_signing_requests")
    .insert(rows)
    .select("*")

  if (error) {
    throw new Error(`Failed to create signing group: ${error.message}`)
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const links = (signingRequests ?? []).map((request, index) => ({
    signingRequest: request,
    token: tokens[index],
    url: appUrl ? `${appUrl}/d/${tokens[index]}` : `/d/${tokens[index]}`,
  }))

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "document_signing_group",
    entityId: groupId,
    after: { document_id: document.id, signer_count: rows.length },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "document_signing_group_created",
    entityType: "document",
    entityId: document.id,
    payload: { group_id: groupId, signer_count: rows.length },
  })

  return { groupId, links }
}

export async function listDocumentFields({
  documentId,
  revision = 1,
  orgId,
}: {
  documentId: string
  revision?: number
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("document_fields")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("document_id", documentId)
    .eq("revision", revision)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to load document fields: ${error.message}`)
  }

  return data ?? []
}

export async function replaceDocumentFields({
  documentId,
  revision = 1,
  fields,
  orgId,
}: {
  documentId: string
  revision?: number
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
  }>
  orgId?: string
}) {
  const parsedFields = fields.map((field) => documentFieldInputSchema.parse(field))
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { error: deleteError } = await supabase
    .from("document_fields")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("document_id", documentId)
    .eq("revision", revision)

  if (deleteError) {
    throw new Error(`Failed to clear document fields: ${deleteError.message}`)
  }

  if (parsedFields.length === 0) {
    return []
  }

  const rows = parsedFields.map((field, index) => ({
    org_id: resolvedOrgId,
    document_id: documentId,
    revision,
    page_index: field.page_index,
    field_type: field.field_type,
    label: field.label ?? null,
    required: field.required ?? true,
    signer_role: field.signer_role ?? "client",
    x: field.x,
    y: field.y,
    w: field.w,
    h: field.h,
    sort_order: field.sort_order ?? index,
    metadata: field.metadata ?? {},
  }))

  const { data, error } = await supabase
    .from("document_fields")
    .insert(rows)
    .select("*")

  if (error) {
    throw new Error(`Failed to save document fields: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "document",
    entityId: documentId,
    after: { revision, fields: rows },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "document_fields_updated",
    entityType: "document",
    entityId: documentId,
    payload: { revision, field_count: rows.length },
  })

  return data ?? []
}
