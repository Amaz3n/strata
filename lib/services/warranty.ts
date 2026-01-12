import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { warrantyRequestInputSchema, warrantyRequestUpdateSchema, type WarrantyRequestInput, type WarrantyRequestUpdate } from "@/lib/validation/warranty"
import type { WarrantyRequest } from "@/lib/types"

function mapWarranty(row: any): WarrantyRequest {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? null,
    status: row.status ?? "open",
    priority: row.priority ?? "normal",
    requested_by: row.requested_by ?? null,
    created_at: row.created_at,
    closed_at: row.closed_at ?? null,
  }
}

export async function listWarrantyRequests(projectId: string, orgId?: string): Promise<WarrantyRequest[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("warranty_requests")
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load warranty requests: ${error.message}`)
  return (data ?? []).map(mapWarranty)
}

export async function createWarrantyRequest({
  input,
  orgId,
}: {
  input: WarrantyRequestInput
  orgId?: string
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("warranty_requests")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      description: parsed.description ?? null,
      status: parsed.status ?? "open",
      priority: parsed.priority ?? "normal",
    })
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create warranty request: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "warranty_request_created",
    entityType: "warranty_request",
    entityId: data.id as string,
    payload: { project_id: parsed.project_id, title: parsed.title },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "warranty_request",
    entityId: data.id as string,
    after: data,
  })

  return mapWarranty(data)
}

export async function updateWarrantyRequest({
  requestId,
  input,
  orgId,
}: {
  requestId: string
  input: WarrantyRequestUpdate
  orgId?: string
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("warranty_requests")
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", requestId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Warranty request not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.priority !== undefined) updateData.priority = parsed.priority
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    if (parsed.status === "closed" || parsed.status === "resolved") {
      updateData.closed_at = new Date().toISOString()
    } else if (existing.closed_at) {
      updateData.closed_at = null
    }
  }

  const { data, error } = await supabase
    .from("warranty_requests")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", requestId)
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update warranty request: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "warranty_request_updated",
    entityType: "warranty_request",
    entityId: requestId,
    payload: { project_id: data.project_id, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "warranty_request",
    entityId: requestId,
    before: existing,
    after: data,
  })

  return mapWarranty(data)
}

export async function createWarrantyRequestFromPortal({
  orgId,
  projectId,
  contactId,
  input,
}: {
  orgId: string
  projectId: string
  contactId?: string | null
  input: WarrantyRequestInput
}): Promise<WarrantyRequest> {
  const parsed = warrantyRequestInputSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("warranty_requests")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title: parsed.title,
      description: parsed.description ?? null,
      status: "open",
      priority: parsed.priority ?? "normal",
      requested_by: contactId ?? null,
    })
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create warranty request: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "warranty_request_created",
    entityType: "warranty_request",
    entityId: data.id as string,
    payload: { project_id: projectId, title: parsed.title, created_via_portal: true },
  })

  return mapWarranty(data)
}

export async function listWarrantyRequestsForPortal(orgId: string, projectId: string): Promise<WarrantyRequest[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("warranty_requests")
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load warranty requests: ${error.message}`)
  }

  return (data ?? []).map(mapWarranty)
}
