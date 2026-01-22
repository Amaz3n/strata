import type { Contact } from "@/lib/types"
import {
  createProspectInputSchema,
  updateProspectInputSchema,
  addTouchInputSchema,
  setFollowUpInputSchema,
  changeStatusInputSchema,
  prospectFiltersSchema,
  type CreateProspectInput,
  type UpdateProspectInput,
  type AddTouchInput,
  type SetFollowUpInput,
  type ChangeStatusInput,
  type ProspectFilters,
  type CrmMetadata,
  type LeadStatus,
  type LeadPriority,
  type TouchType,
} from "@/lib/validation/crm"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

// Extended prospect type with CRM metadata
export interface Prospect extends Contact {
  lead_status?: LeadStatus
  lead_priority?: LeadPriority
  lead_owner_user_id?: string
  next_follow_up_at?: string | null
  last_contacted_at?: string | null
  lead_lost_reason?: string
  lead_project_type?: string
  lead_budget_range?: string
  lead_timeline_preference?: string
  lead_tags?: string[]
  jobsite_location?: {
    street?: string
    city?: string
    state?: string
    postal_code?: string
  }
  // Computed
  has_estimate?: boolean
  estimate_count?: number
}

export interface CrmActivity {
  id: string
  event_type: string
  touch_type?: TouchType
  title: string
  description?: string
  actor_name?: string
  created_at: string
  entity_id?: string
  contact_name?: string
}

export interface CrmDashboardStats {
  followUpsDueToday: number
  followUpsOverdue: number
  newInquiries: number
  inEstimating: number
  totalProspects: number
  wonThisMonth: number
  lostThisMonth: number
}

function mapProspect(row: any): Prospect {
  const metadata = row?.metadata ?? {}
  return {
    id: row.id,
    org_id: row.org_id,
    full_name: row.full_name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    role: row.role ?? undefined,
    contact_type: row.contact_type ?? "client",
    primary_company_id: row.primary_company_id ?? undefined,
    has_portal_access: metadata.has_portal_access ?? false,
    preferred_contact_method: metadata.preferred_contact_method ?? undefined,
    notes: metadata.notes ?? undefined,
    external_crm_id: row.external_crm_id ?? undefined,
    crm_source: row.crm_source ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    // CRM fields from metadata
    lead_status: metadata.lead_status ?? "new",
    lead_priority: metadata.lead_priority ?? "normal",
    lead_owner_user_id: metadata.lead_owner_user_id ?? undefined,
    next_follow_up_at: metadata.next_follow_up_at ?? null,
    last_contacted_at: metadata.last_contacted_at ?? null,
    lead_lost_reason: metadata.lead_lost_reason ?? undefined,
    lead_project_type: metadata.lead_project_type ?? undefined,
    lead_budget_range: metadata.lead_budget_range ?? undefined,
    lead_timeline_preference: metadata.lead_timeline_preference ?? undefined,
    lead_tags: metadata.lead_tags ?? [],
    jobsite_location: metadata.jobsite_location ?? undefined,
    // Computed fields
    has_estimate: row.estimate_count > 0,
    estimate_count: row.estimate_count ?? 0,
  }
}

export async function listProspects(orgId?: string, filters?: ProspectFilters): Promise<Prospect[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const parsedFilters = prospectFiltersSchema.parse(filters ?? undefined) ?? {}

  // Query contacts that are clients (prospects)
  let query = supabase
    .from("contacts")
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .eq("org_id", resolvedOrgId)
    .eq("contact_type", "client")
    .is("metadata->>archived_at", null)
    .order("created_at", { ascending: false })

  // Apply filters
  if (parsedFilters.lead_status) {
    query = query.eq("metadata->>lead_status", parsedFilters.lead_status)
  }
  if (parsedFilters.lead_priority) {
    query = query.eq("metadata->>lead_priority", parsedFilters.lead_priority)
  }
  if (parsedFilters.lead_owner_user_id) {
    query = query.eq("metadata->>lead_owner_user_id", parsedFilters.lead_owner_user_id)
  }
  if (parsedFilters.search) {
    query = query.or(
      ["full_name.ilike.%{search}%", "email.ilike.%{search}%", "phone.ilike.%{search}%"]
        .join(",")
        .replaceAll("{search}", parsedFilters.search),
    )
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list prospects: ${error.message}`)
  }

  let prospects = (data ?? []).map(mapProspect)

  // Get estimate counts
  const contactIds = prospects.map(p => p.id)
  if (contactIds.length > 0) {
    const { data: estimateCounts } = await supabase
      .from("estimates")
      .select("recipient_contact_id")
      .eq("org_id", resolvedOrgId)
      .in("recipient_contact_id", contactIds)

    const countMap = new Map<string, number>()
    for (const est of estimateCounts ?? []) {
      if (est.recipient_contact_id) {
        countMap.set(est.recipient_contact_id, (countMap.get(est.recipient_contact_id) ?? 0) + 1)
      }
    }
    prospects = prospects.map(p => ({
      ...p,
      estimate_count: countMap.get(p.id) ?? 0,
      has_estimate: (countMap.get(p.id) ?? 0) > 0,
    }))
  }

  // Apply follow-up filters in memory (since we need date comparison)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

  if (parsedFilters.follow_up_overdue) {
    prospects = prospects.filter(p => p.next_follow_up_at && p.next_follow_up_at < todayStart)
  }
  if (parsedFilters.follow_up_today) {
    prospects = prospects.filter(p =>
      p.next_follow_up_at &&
      p.next_follow_up_at >= todayStart &&
      p.next_follow_up_at < todayEnd
    )
  }

  return prospects
}

export async function getProspect(contactId: string, orgId?: string): Promise<Prospect> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("contacts")
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Prospect not found")
  }

  // Get estimate count
  const { count } = await supabase
    .from("estimates")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("recipient_contact_id", contactId)

  return {
    ...mapProspect(data),
    estimate_count: count ?? 0,
    has_estimate: (count ?? 0) > 0,
  }
}

export async function createProspect({ input, orgId }: { input: CreateProspectInput; orgId?: string }): Promise<Prospect> {
  const parsed = createProspectInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Build metadata with CRM fields
  const metadata: CrmMetadata & { notes?: string } = {
    lead_status: parsed.lead_status ?? "new",
    lead_priority: parsed.lead_priority ?? "normal",
    lead_owner_user_id: parsed.lead_owner_user_id ?? userId,
    next_follow_up_at: parsed.next_follow_up_at,
    lead_project_type: parsed.lead_project_type,
    lead_budget_range: parsed.lead_budget_range,
    lead_timeline_preference: parsed.lead_timeline_preference,
    lead_tags: parsed.lead_tags,
    jobsite_location: parsed.jobsite_location,
    notes: parsed.notes,
  }

  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: resolvedOrgId,
      full_name: parsed.full_name,
      email: parsed.email || null,
      phone: parsed.phone || null,
      role: parsed.role || null,
      contact_type: "client",
      crm_source: parsed.crm_source || null,
      metadata,
    })
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create prospect: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "crm_prospect_created",
    entityType: "contact",
    entityId: data.id as string,
    payload: {
      name: data.full_name,
      lead_status: metadata.lead_status,
      crm_source: parsed.crm_source,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "contact",
    entityId: data.id as string,
    after: data,
  })

  return mapProspect(data)
}

export async function updateProspect({
  contactId,
  input,
  orgId,
}: {
  contactId: string
  input: UpdateProspectInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = updateProspectInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Get existing contact
  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect not found")
  }

  // Merge metadata
  const existingMetadata = existing.metadata ?? {}
  const metadata = {
    ...existingMetadata,
    ...(parsed.lead_status !== undefined && { lead_status: parsed.lead_status }),
    ...(parsed.lead_priority !== undefined && { lead_priority: parsed.lead_priority }),
    ...(parsed.lead_owner_user_id !== undefined && { lead_owner_user_id: parsed.lead_owner_user_id }),
    ...(parsed.next_follow_up_at !== undefined && { next_follow_up_at: parsed.next_follow_up_at }),
    ...(parsed.lead_lost_reason !== undefined && { lead_lost_reason: parsed.lead_lost_reason }),
    ...(parsed.lead_project_type !== undefined && { lead_project_type: parsed.lead_project_type }),
    ...(parsed.lead_budget_range !== undefined && { lead_budget_range: parsed.lead_budget_range }),
    ...(parsed.lead_timeline_preference !== undefined && { lead_timeline_preference: parsed.lead_timeline_preference }),
    ...(parsed.lead_tags !== undefined && { lead_tags: parsed.lead_tags }),
    ...(parsed.jobsite_location !== undefined && { jobsite_location: parsed.jobsite_location }),
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({ metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update prospect: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "contact",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapProspect(data)
}

export async function changeLeadStatus({
  input,
  orgId,
}: {
  input: ChangeStatusInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = changeStatusInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Get existing contact
  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect not found")
  }

  const existingMetadata = existing.metadata ?? {}
  const oldStatus = existingMetadata.lead_status ?? "new"
  const metadata = {
    ...existingMetadata,
    lead_status: parsed.lead_status,
    ...(parsed.lead_lost_reason && { lead_lost_reason: parsed.lead_lost_reason }),
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({ metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to change status: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "crm_lead_status_changed",
    entityType: "contact",
    entityId: data.id as string,
    payload: {
      name: data.full_name,
      old_status: oldStatus,
      new_status: parsed.lead_status,
      lost_reason: parsed.lead_lost_reason,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "contact",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapProspect(data)
}

export async function setFollowUp({
  input,
  orgId,
}: {
  input: SetFollowUpInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = setFollowUpInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect not found")
  }

  const metadata = {
    ...(existing.metadata ?? {}),
    next_follow_up_at: parsed.next_follow_up_at,
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({ metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
    .select(`
      id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
      external_crm_id, crm_source, metadata, created_at, updated_at
    `)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to set follow-up: ${error?.message}`)
  }

  if (parsed.next_follow_up_at) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "crm_follow_up_set",
      entityType: "contact",
      entityId: data.id as string,
      payload: {
        name: data.full_name,
        next_follow_up_at: parsed.next_follow_up_at,
      },
    })
  }

  return mapProspect(data)
}

export async function addTouch({
  input,
  orgId,
}: {
  input: AddTouchInput
  orgId?: string
}): Promise<void> {
  const parsed = addTouchInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Verify contact exists
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, full_name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
    .maybeSingle()

  if (contactError || !contact) {
    throw new Error("Prospect not found")
  }

  // Record the touch as an event
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "crm_touch_added",
    entityType: "contact",
    entityId: parsed.contact_id,
    payload: {
      name: contact.full_name,
      touch_type: parsed.touch_type,
      title: parsed.title,
      description: parsed.description,
    },
  })

  // Update last_contacted_at
  const metadata = {
    ...(contact.metadata ?? {}),
    last_contacted_at: new Date().toISOString(),
  }

  await supabase
    .from("contacts")
    .update({ metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.contact_id)
}

export async function getProspectActivity(contactId: string, orgId?: string, limit = 20): Promise<CrmActivity[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("events")
    .select("id, event_type, entity_id, payload, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get activity: ${error.message}`)
  }

  return (data ?? []).map(event => {
    const payload = (event.payload ?? {}) as Record<string, any>
    return {
      id: event.id,
      event_type: event.event_type,
      touch_type: payload.touch_type as TouchType | undefined,
      title: payload.title ?? payload.message ?? event.event_type.replace(/_/g, " "),
      description: payload.description,
      actor_name: payload.actor_name,
      created_at: event.created_at,
      entity_id: event.entity_id,
    }
  })
}

export async function getCrmDashboardStats(orgId?: string): Promise<CrmDashboardStats> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  // Get all prospects
  const { data: prospects } = await supabase
    .from("contacts")
    .select("id, metadata, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("contact_type", "client")
    .is("metadata->>archived_at", null)

  const all = prospects ?? []

  const followUpsDueToday = all.filter(p => {
    const followUp = (p.metadata as any)?.next_follow_up_at
    return followUp && followUp >= todayStart && followUp < todayEnd
  }).length

  const followUpsOverdue = all.filter(p => {
    const followUp = (p.metadata as any)?.next_follow_up_at
    return followUp && followUp < todayStart
  }).length

  const newInquiries = all.filter(p => {
    const status = (p.metadata as any)?.lead_status
    return status === "new" || !status
  }).length

  const inEstimating = all.filter(p => {
    const status = (p.metadata as any)?.lead_status
    return status === "estimating"
  }).length

  const wonThisMonth = all.filter(p => {
    const status = (p.metadata as any)?.lead_status
    const updatedAt = p.updated_at ?? p.created_at
    return status === "won" && updatedAt >= monthStart
  }).length

  const lostThisMonth = all.filter(p => {
    const status = (p.metadata as any)?.lead_status
    const updatedAt = p.updated_at ?? p.created_at
    return status === "lost" && updatedAt >= monthStart
  }).length

  return {
    followUpsDueToday,
    followUpsOverdue,
    newInquiries,
    inEstimating,
    totalProspects: all.length,
    wonThisMonth,
    lostThisMonth,
  }
}

// Get recent activity across all prospects
export async function getRecentActivity(orgId?: string, limit = 10): Promise<CrmActivity[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("events")
    .select("id, event_type, entity_id, payload, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", "contact")
    .in("event_type", [
      "crm_touch_added",
      "crm_prospect_created",
      "crm_lead_status_changed",
      "crm_follow_up_set",
      "crm_estimate_created",
    ])
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get recent activity: ${error.message}`)
  }

  // Fetch contact names for all entity_ids
  const entityIds = [...new Set((data ?? []).map(e => e.entity_id).filter(Boolean))]
  const contactNames: Record<string, string> = {}

  if (entityIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, full_name")
      .in("id", entityIds)

    for (const contact of contacts ?? []) {
      contactNames[contact.id] = contact.full_name
    }
  }

  return (data ?? []).map(event => {
    const payload = (event.payload ?? {}) as Record<string, any>
    return {
      id: event.id,
      event_type: event.event_type,
      touch_type: payload.touch_type as TouchType | undefined,
      title: payload.title ?? payload.name ?? event.event_type.replace(/_/g, " "),
      description: payload.description,
      actor_name: payload.actor_name ?? payload.name,
      created_at: event.created_at,
      entity_id: event.entity_id,
      contact_name: event.entity_id ? contactNames[event.entity_id] : undefined,
    }
  })
}

// Mark a contact as a CRM prospect (for existing contacts)
export async function trackInCrm({
  contactId,
  orgId,
}: {
  contactId: string
  orgId?: string
}): Promise<Prospect> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, contact_type, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Contact not found")
  }

  const existingMetadata = existing.metadata ?? {}

  // Only set lead_status if not already set
  if (!existingMetadata.lead_status) {
    const metadata = {
      ...existingMetadata,
      lead_status: "new",
      lead_priority: "normal",
      lead_owner_user_id: userId,
    }

    const { data, error } = await supabase
      .from("contacts")
      .update({
        contact_type: "client",
        metadata
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", contactId)
      .select(`
        id, org_id, full_name, email, phone, role, contact_type, primary_company_id,
        external_crm_id, crm_source, metadata, created_at, updated_at
      `)
      .maybeSingle()

    if (error || !data) {
      throw new Error(`Failed to track in CRM: ${error?.message}`)
    }

    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "crm_prospect_created",
      entityType: "contact",
      entityId: data.id as string,
      payload: { name: data.full_name, tracked_from_directory: true },
    })

    return mapProspect(data)
  }

  // Already tracked, just return current state
  return mapProspect(existing)
}
