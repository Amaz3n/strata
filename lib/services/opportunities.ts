import {
  createOpportunityInputSchema,
  updateOpportunityInputSchema,
  opportunityFiltersSchema,
  type CreateOpportunityInput,
  type UpdateOpportunityInput,
  type OpportunityFilters,
  type OpportunityStatus,
} from "@/lib/validation/opportunities"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { createProject } from "@/lib/services/projects"

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
    .select(
      `
      id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type,
      budget_range, timeline_preference, source, tags, notes, created_at, updated_at,
      client_contact:contacts(id, full_name, email, phone),
      project:projects!projects_opportunity_id_fkey(id, name, status)
    `,
    )
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
    .select(
      `
      id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type,
      budget_range, timeline_preference, source, tags, notes, created_at, updated_at,
      client_contact:contacts(id, full_name, email, phone),
      project:projects!projects_opportunity_id_fkey(id, name, status)
    `,
    )
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
    .select(
      `
      id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type,
      budget_range, timeline_preference, source, tags, notes, created_at, updated_at,
      client_contact:contacts(id, full_name, email, phone)
    `,
    )
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
    .select("id, org_id, name, status, owner_user_id, jobsite_location, project_type, budget_range, timeline_preference, source, tags, notes")
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

  const { data, error } = await supabase
    .from("opportunities")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", opportunityId)
    .select(
      `
      id, org_id, client_contact_id, name, status, owner_user_id, jobsite_location, project_type,
      budget_range, timeline_preference, source, tags, notes, created_at, updated_at,
      client_contact:contacts(id, full_name, email, phone)
    `,
    )
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
    .select("id, name, status, client_contact_id, jobsite_location")
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
      status: "planning",
      location: opportunity.jobsite_location ?? undefined,
      client_id: opportunity.client_contact_id ?? null,
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
