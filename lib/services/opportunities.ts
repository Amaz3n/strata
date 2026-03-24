import {
  createOpportunityInputSchema,
  updateOpportunityInputSchema,
  opportunityFiltersSchema,
  type CreateOpportunityInput,
  type UpdateOpportunityInput,
  type OpportunityFilters,
  type OpportunityStatus,
} from "@/lib/validation/opportunities"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { createProject, updateProject } from "@/lib/services/projects"

export interface OpportunityContact {
  id: string
  full_name: string
  email?: string
  phone?: string
}

export interface OpportunityProject {
  id: string
  name?: string | null
  status?: string | null
}

export interface Opportunity {
  id: string
  org_id: string
  client_contact_id: string
  name: string
  status: OpportunityStatus
  owner_user_id?: string | null
  jobsite_location?: {
    street?: string
    city?: string
    state?: string
    postal_code?: string
  }
  project_type?: string | null
  budget_range?: string | null
  timeline_preference?: string | null
  source?: string | null
  tags?: string[]
  notes?: string | null
  created_at: string
  updated_at?: string | null
  client_contact?: OpportunityContact
  project?: OpportunityProject | null
}

const opportunitySelect = `
  id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type,
  budget_range, timeline_preference, source, tags, notes, created_at, updated_at,
  client_contact:contacts(id, full_name, email, phone),
  project:projects!projects_opportunity_id_fkey(id, name, status)
`

function normalizeProjectType(projectType?: string | null) {
  switch (projectType) {
    case "new_construction":
    case "remodel":
    case "addition":
    case "renovation":
    case "repair":
      return projectType
    default:
      return undefined
  }
}

function canPromoteProjectToActive(status?: string | null) {
  return status === "planning" || status === "bidding" || status === "on_hold"
}

async function ensureActiveProjectForOpportunity({
  context,
  opportunity,
}: {
  context: OrgServiceContext
  opportunity: {
    id: string
    name: string
    client_contact_id: string
    jobsite_location?: Record<string, unknown> | null
    project_type?: string | null
    notes?: string | null
  }
}): Promise<OpportunityProject> {
  const { supabase, orgId } = context

  const { data: existingProject, error: existingProjectError } = await supabase
    .from("projects")
    .select("id, name, status")
    .eq("org_id", orgId)
    .eq("opportunity_id", opportunity.id)
    .maybeSingle()

  if (existingProjectError) {
    throw new Error(`Failed to load linked project: ${existingProjectError.message}`)
  }

  if (existingProject) {
    if (canPromoteProjectToActive(existingProject.status)) {
      const updatedProject = await updateProject({
        projectId: existingProject.id as string,
        input: { status: "active" },
        context,
      })
      return {
        id: updatedProject.id,
        name: updatedProject.name,
        status: updatedProject.status,
      }
    }

    return {
      id: existingProject.id as string,
      name: (existingProject.name as string | null) ?? null,
      status: (existingProject.status as string | null) ?? null,
    }
  }

  const project = await createProject({
    input: {
      name: opportunity.name,
      status: "active",
      location: opportunity.jobsite_location ?? undefined,
      client_id: opportunity.client_contact_id ?? null,
      project_type: normalizeProjectType(opportunity.project_type),
      description: opportunity.notes ?? undefined,
    },
    context,
  })

  const { error: linkError } = await supabase
    .from("projects")
    .update({ opportunity_id: opportunity.id })
    .eq("org_id", orgId)
    .eq("id", project.id)

  if (linkError) {
    throw new Error(`Failed to link project to opportunity: ${linkError.message}`)
  }

  return {
    id: project.id,
    name: project.name,
    status: project.status,
  }
}

function mapOpportunity(row: any): Opportunity {
  const projectRow = Array.isArray(row.project) ? row.project[0] : row.project
  return {
    id: row.id,
    org_id: row.org_id,
    client_contact_id: row.client_contact_id,
    name: row.name,
    status: row.status,
    owner_user_id: row.owner_user_id ?? null,
    jobsite_location: row.jobsite_location ?? undefined,
    project_type: row.project_type ?? null,
    budget_range: row.budget_range ?? null,
    timeline_preference: row.timeline_preference ?? null,
    source: row.source ?? null,
    tags: row.tags ?? undefined,
    notes: row.notes ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    client_contact: row.client_contact
      ? {
          id: row.client_contact.id,
          full_name: row.client_contact.full_name,
          email: row.client_contact.email ?? undefined,
          phone: row.client_contact.phone ?? undefined,
        }
      : undefined,
    project: projectRow
      ? {
          id: projectRow.id,
          name: projectRow.name ?? null,
          status: projectRow.status ?? null,
        }
      : projectRow ?? null,
  }
}

export async function listOpportunities(orgId?: string, filters?: OpportunityFilters): Promise<Opportunity[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const parsedFilters = opportunityFiltersSchema.parse(filters ?? undefined) ?? {}

  let query = supabase
    .from("opportunities")
    .select(opportunitySelect)
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (parsedFilters.status) {
    query = query.eq("status", parsedFilters.status)
  }
  if (parsedFilters.owner_user_id) {
    query = query.eq("owner_user_id", parsedFilters.owner_user_id)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list opportunities: ${error.message}`)
  }

  let opportunities = (data ?? []).map(mapOpportunity)

  if (parsedFilters.search) {
    const term = parsedFilters.search.toLowerCase()
    opportunities = opportunities.filter((opportunity) => {
      const client = opportunity.client_contact
      const haystack = [
        opportunity.name,
        client?.full_name ?? "",
        client?.email ?? "",
        client?.phone ?? "",
        opportunity.source ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(term)
    })
  }

  return opportunities
}

export async function getOpportunity(opportunityId: string, orgId?: string): Promise<Opportunity> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("opportunities")
    .select(opportunitySelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Opportunity not found")
  }

  return mapOpportunity(data)
}

export async function createOpportunity({
  input,
  orgId,
}: {
  input: CreateOpportunityInput
  orgId?: string
}): Promise<Opportunity> {
  const parsed = createOpportunityInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("opportunities")
    .insert({
      org_id: resolvedOrgId,
      client_contact_id: parsed.client_contact_id,
      name: parsed.name,
      status: parsed.status,
      owner_user_id: parsed.owner_user_id ?? null,
      jobsite_location: parsed.jobsite_location ?? null,
      project_type: parsed.project_type ?? null,
      budget_range: parsed.budget_range ?? null,
      timeline_preference: parsed.timeline_preference ?? null,
      source: parsed.source ?? null,
      tags: parsed.tags ?? null,
      notes: parsed.notes ?? null,
    })
    .select(opportunitySelect)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create opportunity: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "opportunity_created",
    entityType: "opportunity",
    entityId: data.id as string,
    payload: {
      name: data.name,
      status: data.status,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "opportunity",
    entityId: data.id as string,
    after: data,
  })

  return mapOpportunity(data)
}

export async function updateOpportunity({
  opportunityId,
  input,
  orgId,
}: {
  opportunityId: string
  input: UpdateOpportunityInput
  orgId?: string
}): Promise<Opportunity> {
  const parsed = updateOpportunityInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("opportunities")
    .select("id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type, budget_range, timeline_preference, source, tags, notes")
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Opportunity not found")
  }

  const updates: Record<string, any> = {}
  if (parsed.name !== undefined) updates.name = parsed.name
  if (parsed.status !== undefined) updates.status = parsed.status
  if (parsed.owner_user_id !== undefined) updates.owner_user_id = parsed.owner_user_id
  if (parsed.jobsite_location !== undefined) updates.jobsite_location = parsed.jobsite_location
  if (parsed.project_type !== undefined) updates.project_type = parsed.project_type
  if (parsed.budget_range !== undefined) updates.budget_range = parsed.budget_range
  if (parsed.timeline_preference !== undefined) updates.timeline_preference = parsed.timeline_preference
  if (parsed.source !== undefined) updates.source = parsed.source
  if (parsed.tags !== undefined) updates.tags = parsed.tags
  if (parsed.notes !== undefined) updates.notes = parsed.notes

  const nextStatus = parsed.status ?? existing.status
  if (nextStatus === "won" && existing.status !== "won") {
    await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
    await ensureActiveProjectForOpportunity({
      context: { supabase, orgId: resolvedOrgId, userId },
      opportunity: {
        id: opportunityId,
        name: parsed.name ?? existing.name,
        client_contact_id: existing.client_contact_id,
        jobsite_location: parsed.jobsite_location ?? existing.jobsite_location ?? null,
        project_type: parsed.project_type ?? existing.project_type ?? null,
        notes: parsed.notes ?? existing.notes ?? null,
      },
    })
  }

  const { data, error } = await supabase
    .from("opportunities")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .select(opportunitySelect)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update opportunity: ${error?.message}`)
  }

  if (parsed.status && parsed.status !== existing.status) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "opportunity_status_changed",
      entityType: "opportunity",
      entityId: data.id as string,
      payload: {
        from: existing.status,
        to: parsed.status,
      },
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "opportunity",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapOpportunity(data)
}

export async function startEstimating({
  opportunityId,
  orgId,
}: {
  opportunityId: string
  orgId?: string
}): Promise<{ project_id: string; opportunity_id: string; client_contact_id: string | null }> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: opportunity, error } = await supabase
    .from("opportunities")
    .select("id, name, status, client_contact_id, jobsite_location, project_type, notes")
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .maybeSingle()

  if (error || !opportunity) {
    throw new Error("Opportunity not found")
  }

  const { data: existingProject } = await supabase
    .from("projects")
    .select("id, name, status")
    .eq("org_id", resolvedOrgId)
    .eq("opportunity_id", opportunityId)
    .maybeSingle()

  if (existingProject) {
    if (opportunity.status === "won" && canPromoteProjectToActive(existingProject.status)) {
      await updateProject({
        projectId: existingProject.id as string,
        input: { status: "active" },
        context,
      })
    }
    if (["new", "contacted", "qualified"].includes(opportunity.status)) {
      await updateOpportunity({
        opportunityId,
        input: { status: "estimating" },
        orgId: resolvedOrgId,
      })
    }
    return {
      project_id: existingProject.id as string,
      opportunity_id: opportunityId,
      client_contact_id: opportunity.client_contact_id ?? null,
    }
  }

  const project = await createProject({
    input: {
      name: opportunity.name,
      status: opportunity.status === "won" ? "active" : "planning",
      location: opportunity.jobsite_location ?? undefined,
      client_id: opportunity.client_contact_id ?? null,
      project_type: normalizeProjectType(opportunity.project_type),
      description: opportunity.notes ?? undefined,
    },
    context,
  })

  await supabase
    .from("projects")
    .update({ opportunity_id: opportunityId })
    .eq("org_id", resolvedOrgId)
    .eq("id", project.id)

  if (["new", "contacted", "qualified"].includes(opportunity.status)) {
    await updateOpportunity({
      opportunityId,
      input: { status: "estimating" },
      orgId: resolvedOrgId,
    })
  }

  return {
    project_id: project.id,
    opportunity_id: opportunityId,
    client_contact_id: opportunity.client_contact_id ?? null,
  }
}

export async function activateOpportunityProject({
  opportunityId,
  orgId,
}: {
  opportunityId: string
  orgId?: string
}): Promise<{ project_id: string; opportunity_id: string }> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { data: opportunity, error } = await supabase
    .from("opportunities")
    .select("id, name, status, client_contact_id, jobsite_location, project_type, notes")
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .maybeSingle()

  if (error || !opportunity) {
    throw new Error("Opportunity not found")
  }

  if (opportunity.status === "lost") {
    throw new Error("Lost opportunities cannot be activated into projects")
  }

  const project = await ensureActiveProjectForOpportunity({
    context,
    opportunity: {
      id: opportunity.id as string,
      name: opportunity.name as string,
      client_contact_id: opportunity.client_contact_id as string,
      jobsite_location: (opportunity.jobsite_location as Record<string, unknown> | null) ?? null,
      project_type: (opportunity.project_type as string | null) ?? null,
      notes: (opportunity.notes as string | null) ?? null,
    },
  })

  if (opportunity.status !== "won") {
    await updateOpportunity({
      opportunityId,
      input: { status: "won" },
      orgId: resolvedOrgId,
    })
  }

  return {
    project_id: project.id,
    opportunity_id: opportunityId,
  }
}
