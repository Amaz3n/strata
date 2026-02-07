import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import type { SelectionInput } from "@/lib/validation/selections"

export async function listSelectionCategories(orgId: string): Promise<SelectionCategory[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_categories")
    .select("id, org_id, name, description, sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load selection categories: ${error.message}`)
  return data ?? []
}

export async function listSelectionOptions(orgId: string, categoryId: string): Promise<SelectionOption[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_options")
    .select(
      "id, org_id, category_id, name, description, price_cents, price_type, price_delta_cents, image_url, sku, vendor, lead_time_days, sort_order, is_default, is_available",
    )
    .eq("org_id", orgId)
    .eq("category_id", categoryId)
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load selection options: ${error.message}`)
  return data ?? []
}

export async function listProjectSelections(orgId?: string, projectId?: string): Promise<Selection[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("project_selections")
    .select(
      "id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes",
    )
    .eq("org_id", resolvedOrgId)
    .order("due_date", { ascending: true, nullsFirst: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to load project selections: ${error.message}`)
  return data ?? []
}

export async function selectProjectOption({
  orgId,
  projectId,
  selectionId,
  optionId,
  selectedByContactId,
}: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from("project_selections")
    .update({
      selected_option_id: optionId,
      status: "selected",
      selected_at: nowIso,
      selected_by_contact_id: selectedByContactId ?? null,
    })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", selectionId)

  if (error) {
    throw new Error(`Failed to update selection: ${error.message}`)
  }

  return { success: true }
}

export async function createProjectSelection({ input, orgId }: { input: SelectionInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    category_id: input.category_id,
    status: input.status ?? "pending",
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
  }

  const { data, error } = await supabase
    .from("project_selections")
    .insert(payload)
    .select(
      "id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create selection: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "selection_created",
    entityType: "selection",
    entityId: data.id,
    payload: { project_id: input.project_id, category_id: input.category_id, status: payload.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "selection",
    entityId: data.id,
    after: payload,
  })

  return data as Selection
}

export async function confirmSelectionFromEnvelopeExecution(input: {
  orgId: string
  selectionId: string
  envelopeId?: string | null
  documentId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const { data: selection, error: selectionError } = await supabase
    .from("project_selections")
    .select("id, org_id, project_id, status, confirmed_at, metadata")
    .eq("org_id", input.orgId)
    .eq("id", input.selectionId)
    .maybeSingle()

  if (selectionError || !selection) {
    throw new Error(`Selection not found for envelope execution: ${selectionError?.message ?? "missing"}`)
  }

  const existingMetadata = (selection.metadata ?? {}) as Record<string, any>
  const priorEnvelopeId = existingMetadata.approved_envelope_id ?? null
  const isConfirmedLifecycleStatus =
    selection.status === "confirmed" || selection.status === "ordered" || selection.status === "received"
  const alreadyConfirmedFromSameEnvelope =
    isConfirmedLifecycleStatus &&
    existingMetadata.approved_via_envelope &&
    priorEnvelopeId &&
    input.envelopeId &&
    priorEnvelopeId === input.envelopeId

  if (alreadyConfirmedFromSameEnvelope) {
    await attachFileWithServiceRole({
      orgId: selection.org_id,
      fileId: input.executedFileId,
      projectId: selection.project_id,
      entityType: "selection",
      entityId: input.selectionId,
      linkRole: "executed_selection",
      createdBy: null,
    })

    return { success: true, idempotent: true }
  }

  const nowIso = new Date().toISOString()
  const metadataPatch = {
    ...existingMetadata,
    approved_via_envelope: true,
    approved_envelope_id: input.envelopeId ?? null,
    approved_document_id: input.documentId,
    approved_executed_file_id: input.executedFileId,
    approved_signer_name: input.signerName ?? null,
    approved_signer_email: input.signerEmail ?? null,
    approved_signer_ip: input.signerIp ?? null,
    approved_at: selection.confirmed_at ?? nowIso,
  }
  const needsConfirmationTransition = !isConfirmedLifecycleStatus

  const updatePayload: Record<string, any> = {
    metadata: metadataPatch,
  }
  if (needsConfirmationTransition) {
    updatePayload.status = "confirmed"
    updatePayload.confirmed_at = nowIso
  }

  const { error: updateError } = await supabase
    .from("project_selections")
    .update(updatePayload)
    .eq("org_id", input.orgId)
    .eq("id", input.selectionId)

  if (updateError) {
    throw new Error(`Failed to update selection from envelope execution: ${updateError.message}`)
  }

  await attachFileWithServiceRole({
    orgId: selection.org_id,
    fileId: input.executedFileId,
    projectId: selection.project_id,
    entityType: "selection",
    entityId: input.selectionId,
    linkRole: "executed_selection",
    createdBy: null,
  })

  await recordEvent({
    orgId: selection.org_id,
    eventType: needsConfirmationTransition ? "selection_confirmed" : "selection_confirmation_synced",
    entityType: "selection",
    entityId: input.selectionId,
    payload: {
      source: "envelope_execution",
      envelope_id: input.envelopeId ?? null,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signer_name: input.signerName ?? null,
      signer_email: input.signerEmail ?? null,
      transitioned: needsConfirmationTransition,
    },
  })

  return { success: true, idempotent: false }
}
