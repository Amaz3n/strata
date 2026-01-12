import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { decisionInputSchema, decisionUpdateSchema, type DecisionInput, type DecisionUpdateInput } from "@/lib/validation/decisions"
import type { Decision } from "@/lib/types"

function mapDecision(row: any): Decision {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status ?? "requested",
    due_date: row.due_date ?? undefined,
    approved_at: row.approved_at ?? undefined,
    approved_by: row.approved_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  }
}

export async function listDecisions(projectId: string, orgId?: string): Promise<Decision[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("decisions")
    .select("id, org_id, project_id, title, description, status, due_date, approved_at, approved_by, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load decisions: ${error.message}`)
  }

  return (data ?? []).map(mapDecision)
}

export async function createDecision({
  input,
  orgId,
}: {
  input: DecisionInput
  orgId?: string
}): Promise<Decision> {
  const parsed = decisionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("decisions")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      description: parsed.description ?? null,
      status: parsed.status ?? "requested",
      due_date: parsed.due_date ?? null,
    })
    .select("id, org_id, project_id, title, description, status, due_date, approved_at, approved_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create decision: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "decision_created",
    entityType: "decision",
    entityId: data.id as string,
    payload: { project_id: parsed.project_id, title: parsed.title, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "decision",
    entityId: data.id as string,
    after: data,
  })

  return mapDecision(data)
}

export async function updateDecision({
  decisionId,
  input,
  orgId,
}: {
  decisionId: string
  input: DecisionUpdateInput
  orgId?: string
}): Promise<Decision> {
  const parsed = decisionUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("decisions")
    .select("id, org_id, project_id, title, description, status, due_date, approved_at, approved_by, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Decision not found")
  }

  const updateData: Record<string, any> = {
    updated_at: new Date().toISOString(),
  }

  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.due_date !== undefined) updateData.due_date = parsed.due_date
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    if (parsed.status === "approved") {
      updateData.approved_at = new Date().toISOString()
      updateData.approved_by = userId
    } else if (existing.approved_at) {
      updateData.approved_at = null
      updateData.approved_by = null
    }
  }

  const { data, error } = await supabase
    .from("decisions")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", decisionId)
    .select("id, org_id, project_id, title, description, status, due_date, approved_at, approved_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update decision: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "decision_updated",
    entityType: "decision",
    entityId: decisionId,
    payload: { project_id: data.project_id, status: data.status, title: data.title },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "decision",
    entityId: decisionId,
    before: existing,
    after: data,
  })

  return mapDecision(data)
}
