import type { SupabaseClient } from "@supabase/supabase-js"

import type { Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { projectUpdateSchema } from "@/lib/validation/projects"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

function mapProject(row: any): Project {
  const location = (row.location ?? {}) as Record<string, unknown>
  const address = typeof location.address === "string" ? location.address : (location.formatted as string | undefined)

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    address,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listProjects(orgId?: string): Promise<Project[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listProjectsWithClient(supabase, resolvedOrgId)
}

export async function listProjectsWithClient(supabase: SupabaseClient, orgId: string): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list projects: ${error.message}`)
  }

  return (data ?? []).map(mapProject)
}

export async function createProject({ input, orgId }: { input: ProjectInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const payload = {
    org_id: resolvedOrgId,
    name: input.name,
    status: input.status ?? "active",
    start_date: input.start_date,
    end_date: input.end_date,
    location: input.location ?? (input.address ? { address: input.address } : null),
    created_by: userId,
  }

  const { data, error } = await supabase
    .from("projects")
    .insert(payload)
    .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
    .single()

  if (error) {
    throw new Error(`Failed to create project: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_created",
    entityType: "project",
    entityId: data.id as string,
    payload: { name: input.name },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "project",
    entityId: data.id as string,
    after: data,
  })

  return mapProject(data)
}

export async function updateProject({
  projectId,
  input,
  orgId,
}: {
  projectId: string
  input: Partial<ProjectInput>
  orgId?: string
}) {
  const parsed = projectUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await supabase
    .from("projects")
    .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error(`Project not found or not accessible`)
  }

  const updatePayload = {
    name: parsed.name ?? existing.data.name,
    status: parsed.status ?? existing.data.status,
    start_date: parsed.start_date ?? existing.data.start_date,
    end_date: parsed.end_date ?? existing.data.end_date,
    location:
      parsed.location ?? (parsed.address ? { address: parsed.address } : existing.data.location ?? null),
  }

  const { data, error } = await supabase
    .from("projects")
    .update(updatePayload)
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update project: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_updated",
    entityType: "project",
    entityId: data.id as string,
    payload: { name: data.name, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project",
    entityId: data.id as string,
    before: existing.data,
    after: data,
  })

  return mapProject(data)
}

export async function archiveProject(projectId: string, orgId?: string) {
  return updateProject({
    projectId,
    orgId,
    input: { status: "cancelled" },
  })
}
