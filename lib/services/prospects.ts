import { COOP_AGENT_ROLE } from "@/lib/sales/activity"
import { serializeLostReason } from "@/lib/sales/lost-reasons"
import {
  createProspectInputSchema,
  logProspectContactInputSchema,
  markProspectLostInputSchema,
  prospectContactInputSchema,
  prospectFiltersSchema,
  updateDealDetailsInputSchema,
  updateProspectContactInputSchema,
  updateProspectInputSchema,
  type CreateProspectInput,
  type LogProspectContactInput,
  type MarkProspectLostInput,
  type ProspectContactInput,
  type ProspectFilters,
  type ProspectStatus,
  type UpdateDealDetailsInput,
  type UpdateProspectContactInput,
  type UpdateProspectInput,
} from "@/lib/validation/prospects"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

export interface ProspectContact {
  id: string
  org_id: string
  prospect_id: string
  contact_id?: string | null
  full_name: string
  email?: string | null
  phone?: string | null
  role?: string | null
  company_name?: string | null
  is_primary: boolean
  promoted_contact_id?: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at?: string | null
}

export interface Prospect {
  id: string
  org_id: string
  name: string
  status: ProspectStatus
  owner_user_id?: string | null
  community_id?: string | null
  community_name?: string | null
  source?: string | null
  jobsite_location?: {
    street?: string
    city?: string
    state?: string
    postal_code?: string
  } | null
  project_type?: string | null
  budget_range?: string | null
  timeline_preference?: string | null
  tags: string[]
  notes?: string | null
  lost_reason?: string | null
  next_follow_up_at?: string | null
  won_at?: string | null
  lost_at?: string | null
  created_by?: string | null
  created_at: string
  updated_at?: string | null
  contacts?: ProspectContact[]
  primary_contact?: ProspectContact | null
  estimate_count?: number
  estimate_value_cents?: number
  has_estimate?: boolean
  project_id?: string | null
}

const prospectSelect = `
  id, org_id, name, status, owner_user_id, community_id, source, jobsite_location, project_type,
  budget_range, timeline_preference, tags, notes, lost_reason, next_follow_up_at, won_at, lost_at,
  created_by, created_at, updated_at, community:communities(name)
`

const prospectContactSelect = `
  id, org_id, prospect_id, contact_id, full_name, email, phone, role, company_name,
  is_primary, promoted_contact_id, metadata, created_at, updated_at
`

function mapProspect(
  row: any,
  contacts?: ProspectContact[],
  extras: { estimateCount?: number; estimateValueCents?: number; projectId?: string | null } = {},
): Prospect {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    owner_user_id: row.owner_user_id ?? null,
    community_id: row.community_id ?? null,
    community_name: (Array.isArray(row.community) ? row.community[0]?.name : row.community?.name) ?? null,
    source: row.source ?? null,
    jobsite_location: row.jobsite_location ?? null,
    project_type: row.project_type ?? null,
    budget_range: row.budget_range ?? null,
    timeline_preference: row.timeline_preference ?? null,
    tags: row.tags ?? [],
    notes: row.notes ?? null,
    lost_reason: row.lost_reason ?? null,
    next_follow_up_at: row.next_follow_up_at ?? null,
    won_at: row.won_at ?? null,
    lost_at: row.lost_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    contacts,
    primary_contact: contacts?.find((contact) => contact.is_primary) ?? contacts?.[0] ?? null,
    estimate_count: extras.estimateCount ?? 0,
    estimate_value_cents: extras.estimateValueCents ?? 0,
    has_estimate: (extras.estimateCount ?? 0) > 0,
    project_id: extras.projectId ?? null,
  }
}

function mapProspectContact(row: any): ProspectContact {
  return {
    id: row.id,
    org_id: row.org_id,
    prospect_id: row.prospect_id,
    contact_id: row.contact_id ?? null,
    full_name: row.full_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    role: row.role ?? null,
    company_name: row.company_name ?? null,
    is_primary: Boolean(row.is_primary),
    promoted_contact_id: row.promoted_contact_id ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  }
}

function applyTerminalStatusDates(
  updates: Record<string, unknown>,
  nextStatus?: ProspectStatus,
  currentStatus?: ProspectStatus,
) {
  if (!nextStatus || nextStatus === currentStatus) {
    return
  }

  if (nextStatus === "won") {
    updates.won_at = new Date().toISOString()
    updates.lost_at = null
    updates.lost_reason = null
    return
  }

  if (nextStatus === "lost") {
    updates.lost_at = new Date().toISOString()
    updates.won_at = null
    return
  }

  if (currentStatus === "won") {
    updates.won_at = null
  }
  if (currentStatus === "lost") {
    updates.lost_at = null
  }
}

async function setPrimaryContactIfNeeded({
  supabase,
  orgId,
  prospectId,
  contactId,
  isPrimary,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  prospectId: string
  contactId?: string
  isPrimary?: boolean
}) {
  if (!isPrimary) {
    return
  }

  let query = supabase
    .from("prospect_contacts")
    .update({ is_primary: false, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .eq("is_primary", true)

  if (contactId) {
    query = query.neq("id", contactId)
  }

  const { error } = await query
  if (error) {
    throw new Error(`Failed to update primary prospect contact: ${error.message}`)
  }
}

export async function listProspects(orgId?: string, filters?: ProspectFilters): Promise<Prospect[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const parsedFilters = prospectFiltersSchema.parse(filters ?? undefined) ?? {}

  let query = supabase
    .from("prospects")
    .select(prospectSelect)
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (parsedFilters.status) {
    query = query.eq("status", parsedFilters.status)
  }
  if (parsedFilters.owner_user_id) {
    query = query.eq("owner_user_id", parsedFilters.owner_user_id)
  }
  if (parsedFilters.community_id) {
    query = query.eq("community_id", parsedFilters.community_id)
  }
  if (parsedFilters.search) {
    query = query.ilike("name", `%${parsedFilters.search}%`)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list prospects: ${error.message}`)
  }

  const rows = data ?? []
  const prospectIds = rows.map((row: any) => row.id as string)

  const contactsByProspect = new Map<string, ProspectContact[]>()
  const estimateCountsByProspect = new Map<string, number>()
  const estimateValueByProspect = new Map<string, number>()
  const projectByProspect = new Map<string, string>()

  if (prospectIds.length > 0) {
    const [contactsResult, estimatesResult, projectsResult] = await Promise.all([
      supabase
        .from("prospect_contacts")
        .select(prospectContactSelect)
        .eq("org_id", resolvedOrgId)
        .in("prospect_id", prospectIds)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      supabase
        .from("estimates")
        .select("prospect_id, total_cents, is_current_version")
        .eq("org_id", resolvedOrgId)
        .in("prospect_id", prospectIds),
      supabase
        .from("projects")
        .select("id, prospect_id")
        .eq("org_id", resolvedOrgId)
        .in("prospect_id", prospectIds),
    ])

    if (contactsResult.error) {
      throw new Error(`Failed to list prospect contacts: ${contactsResult.error.message}`)
    }
    if (estimatesResult.error) {
      throw new Error(`Failed to count prospect estimates: ${estimatesResult.error.message}`)
    }
    if (projectsResult.error) {
      throw new Error(`Failed to list prospect projects: ${projectsResult.error.message}`)
    }

    for (const row of contactsResult.data ?? []) {
      const contact = mapProspectContact(row)
      contactsByProspect.set(contact.prospect_id, [...(contactsByProspect.get(contact.prospect_id) ?? []), contact])
    }

    for (const estimate of estimatesResult.data ?? []) {
      const prospectId = estimate.prospect_id as string | null
      if (prospectId) {
        estimateCountsByProspect.set(prospectId, (estimateCountsByProspect.get(prospectId) ?? 0) + 1)
        // Only current versions contribute to pipeline value so superseded drafts don't double-count.
        if (estimate.is_current_version) {
          estimateValueByProspect.set(
            prospectId,
            (estimateValueByProspect.get(prospectId) ?? 0) + (estimate.total_cents ?? 0),
          )
        }
      }
    }

    for (const project of projectsResult.data ?? []) {
      const prospectId = project.prospect_id as string | null
      if (prospectId) {
        projectByProspect.set(prospectId, project.id as string)
      }
    }
  }

  return rows.map((row: any) =>
    mapProspect(row, contactsByProspect.get(row.id), {
      estimateCount: estimateCountsByProspect.get(row.id) ?? 0,
      estimateValueCents: estimateValueByProspect.get(row.id) ?? 0,
      projectId: projectByProspect.get(row.id) ?? null,
    }),
  )
}

export interface ProspectActivity {
  id: string
  event_type: string
  payload: Record<string, unknown> | null
  created_at: string
}

/** Prospect-scoped event timeline, shown in the detail sheet (replaces the old org-wide CRM feed). */
export async function listProspectActivity(prospectId: string, orgId?: string, limit = 12): Promise<ProspectActivity[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Fetch estimates associated with this prospect
  const { data: estimates } = await supabase
    .from("estimates")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("prospect_id", prospectId)

  const estimateIds = (estimates ?? []).map((e) => e.id)

  let query = supabase
    .from("events")
    .select("id, event_type, payload, created_at")
    .eq("org_id", resolvedOrgId)

  if (estimateIds.length > 0) {
    // Query events where entity is this prospect OR any of this prospect's estimates
    const orFilter = `and(entity_type.eq.prospect,entity_id.eq.${prospectId}),and(entity_type.eq.estimate,entity_id.in.(${estimateIds.join(",")}))`
    query = query.or(orFilter)
  } else {
    query = query.eq("entity_type", "prospect").eq("entity_id", prospectId)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to load prospect activity: ${error.message}`)
  }

  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    event_type: row.event_type as string,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    created_at: row.created_at as string,
  }))
}

export async function getProspect(prospectId: string, orgId?: string): Promise<Prospect> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("prospects")
    .select(prospectSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Prospect not found")
  }

  const [contacts, estimatesResult, projectResult] = await Promise.all([
    listProspectContacts(prospectId, resolvedOrgId),
    supabase
      .from("estimates")
      .select("total_cents, is_current_version")
      .eq("org_id", resolvedOrgId)
      .eq("prospect_id", prospectId),
    supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("prospect_id", prospectId)
      .maybeSingle(),
  ])

  const estimates = estimatesResult.data ?? []
  const estimateValueCents = estimates.reduce(
    (sum, estimate) => sum + (estimate.is_current_version ? (estimate.total_cents ?? 0) : 0),
    0,
  )

  return mapProspect(data, contacts, {
    estimateCount: estimates.length,
    estimateValueCents,
    projectId: (projectResult.data?.id as string | undefined) ?? null,
  })
}

export async function createProspect({
  input,
  orgId,
}: {
  input: CreateProspectInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = createProspectInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const insert: Record<string, unknown> = {
    org_id: resolvedOrgId,
    name: parsed.name,
    status: parsed.status,
    owner_user_id: parsed.owner_user_id ?? userId,
    community_id: parsed.community_id ?? null,
    source: parsed.source ?? null,
    jobsite_location: parsed.jobsite_location ?? null,
    project_type: parsed.project_type ?? null,
    budget_range: parsed.budget_range ?? null,
    timeline_preference: parsed.timeline_preference ?? null,
    tags: parsed.tags ?? [],
    notes: parsed.notes ?? null,
    created_by: userId,
  }
  applyTerminalStatusDates(insert, parsed.status)

  const { data, error } = await supabase.from("prospects").insert(insert).select(prospectSelect).single()

  if (error || !data) {
    throw new Error(`Failed to create prospect: ${error?.message}`)
  }

  let contacts: ProspectContact[] = []
  if (parsed.primary_contact) {
    contacts = [
      await createProspectContact({
        prospectId: data.id as string,
        input: { ...parsed.primary_contact, is_primary: true },
        orgId: resolvedOrgId,
      }),
    ]
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "prospect_created",
    entityType: "prospect",
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
    entityType: "prospect",
    entityId: data.id as string,
    after: data,
  })

  return mapProspect(data, contacts)
}

/**
 * Sets (or clears) a prospect's follow-up. Records the current user as the reminder owner and
 * re-arms the reminder (clears notified_at) so the cron sweep emails them once at the new time.
 */
export async function setProspectFollowUp({
  prospectId,
  nextFollowUpAt,
  orgId,
}: {
  prospectId: string
  nextFollowUpAt: string | null
  orgId?: string
}): Promise<Prospect> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("prospects")
    .update({
      next_follow_up_at: nextFollowUpAt,
      next_follow_up_user_id: nextFollowUpAt ? userId : null,
      next_follow_up_notified_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .select(prospectSelect)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update follow-up: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: nextFollowUpAt ? "prospect_follow_up_set" : "prospect_follow_up_cleared",
    entityType: "prospect",
    entityId: prospectId,
    payload: nextFollowUpAt ? { next_follow_up_at: nextFollowUpAt } : {},
  })

  const contacts = await listProspectContacts(prospectId, resolvedOrgId)
  return mapProspect(data, contacts)
}

/**
 * Records that somebody actually talked to this buyer. Written as an event so it
 * lands in one timeline with holds, pricing and signatures instead of a parallel
 * notes table, and so the "no contact in N days" question has a single source.
 */
export async function logProspectContact({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: LogProspectContactInput
  orgId?: string
}): Promise<void> {
  const parsed = logProspectContactInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: prospect, error } = await supabase
    .from("prospects")
    .select("id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .maybeSingle()
  if (error || !prospect) throw new Error("Prospect not found")

  // Talking to a new inquiry IS the inquiry → working transition, so the touch
  // makes it. Nothing else on the Sales desk moves a prospect off `new`, and a
  // stage observed from state must be moved by the act that changed the state —
  // otherwise you call a buyer three times and they stay a "New inquiry"
  // forever while the New inquiries chip never drains.
  const advanced = prospect.status === "new"
  await supabase
    .from("prospects")
    .update({
      updated_at: new Date().toISOString(),
      ...(advanced ? { status: "contacted" } : {}),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "prospect_contact_logged",
    entityType: "prospect",
    entityId: prospectId,
    payload: { kind: parsed.kind, note: parsed.note ?? null, occurred_at: parsed.occurredAt ?? null },
  })

  // Emitted separately so the deal file's log shows the stage move as its own
  // line, the way every other observed transition appears.
  if (advanced) {
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "prospect_status_changed",
      entityType: "prospect",
      entityId: prospectId,
      payload: { from: "new", to: "contacted", reason: "contact_logged" },
    })
  }
}

/**
 * Correcting a deal: the buyer's name and contact details, and who owns it.
 *
 * Holding a lot *promotes* the prospect contact into a `contacts` row and the
 * board then reads the buyer's name from there — so an edit that only touched
 * the lead record would appear to do nothing the moment a deal reached hold.
 * Both rows move together.
 */
export async function updateDealDetails({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: UpdateDealDetailsInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = updateDealDetailsInputSchema.parse(input)
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const email = parsed.email?.trim() || null
  const phone = parsed.phone?.trim() || null
  const contacts = await listProspectContacts(prospectId, resolvedOrgId)
  const primary = contacts.find((contact) => contact.is_primary) ?? contacts[0] ?? null

  if (primary) {
    await updateProspectContact({
      contactId: primary.id,
      input: { full_name: parsed.fullName, phone, email, is_primary: true },
      orgId: resolvedOrgId,
    })
    if (primary.promoted_contact_id) {
      const { updateContact } = await import("@/lib/services/contacts")
      await updateContact({
        contactId: primary.promoted_contact_id,
        input: { full_name: parsed.fullName, phone: phone ?? undefined, email: email ?? undefined },
        orgId: resolvedOrgId,
      })
    }
  } else {
    await createProspectContact({
      prospectId,
      input: { full_name: parsed.fullName, phone, email, is_primary: true },
      orgId: resolvedOrgId,
    })
  }

  // The co-op agent is one secondary contact, reconciled rather than appended —
  // otherwise correcting a brokerage's spelling leaves two brokers on the deal.
  const coopName = parsed.coopAgentName?.trim() || null
  const coopBrokerage = parsed.coopBrokerage?.trim() || null
  const existingCoop = contacts.find((contact) => !contact.is_primary && contact.role === COOP_AGENT_ROLE)
  if (coopName && existingCoop) {
    await updateProspectContact({
      contactId: existingCoop.id,
      input: { full_name: coopName, company_name: coopBrokerage, role: COOP_AGENT_ROLE },
      orgId: resolvedOrgId,
    })
  } else if (coopName) {
    await createProspectContact({
      prospectId,
      input: { full_name: coopName, company_name: coopBrokerage, role: COOP_AGENT_ROLE, is_primary: false },
      orgId: resolvedOrgId,
    })
  } else if (existingCoop) {
    await deleteProspectContact({ contactId: existingCoop.id, orgId: resolvedOrgId })
  }

  return updateProspect({
    prospectId,
    input: {
      name: parsed.fullName,
      owner_user_id: parsed.ownerUserId ?? null,
      community_id: parsed.communityId ?? null,
      source: parsed.source ?? null,
      project_type: parsed.planInterest ?? null,
      budget_range: parsed.priceRange ?? null,
      timeline_preference: parsed.timeframe ?? null,
      notes: parsed.notes ?? null,
    },
    orgId: resolvedOrgId,
  })
}

/**
 * Working a follow-up off the list: record the touch and clear the reminder in
 * one call, because they are one act. Splitting them is how a board ends up full
 * of follow-ups that were made but never marked.
 */
export async function completeProspectFollowUp({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: LogProspectContactInput
  orgId?: string
}): Promise<Prospect> {
  await logProspectContact({ prospectId, input, orgId })
  return setProspectFollowUp({ prospectId, nextFollowUpAt: null, orgId })
}

/**
 * Closes a prospect out with a reason code. The code — not a free-text note — is
 * what makes a cancellation report countable, so it is required.
 */
export async function markProspectLost({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: MarkProspectLostInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = markProspectLostInputSchema.parse(input)
  return updateProspect({
    prospectId,
    input: {
      status: "lost",
      lost_reason: serializeLostReason(parsed.reasonCode, parsed.note),
      next_follow_up_at: null,
    },
    orgId,
  })
}

/** Puts a lost deal back in the book — buyers come back, and financing gets fixed. */
export async function reopenProspect({
  prospectId,
  orgId,
}: {
  prospectId: string
  orgId?: string
}): Promise<Prospect> {
  return updateProspect({ prospectId, input: { status: "contacted", lost_reason: null }, orgId })
}

export async function updateProspect({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: UpdateProspectInput
  orgId?: string
}): Promise<Prospect> {
  const parsed = updateProspectInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("prospects")
    .select(prospectSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect not found")
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.name !== undefined) updates.name = parsed.name
  if (parsed.status !== undefined) updates.status = parsed.status
  if (parsed.owner_user_id !== undefined) updates.owner_user_id = parsed.owner_user_id
  if (parsed.community_id !== undefined) updates.community_id = parsed.community_id
  if (parsed.source !== undefined) updates.source = parsed.source
  if (parsed.jobsite_location !== undefined) updates.jobsite_location = parsed.jobsite_location
  if (parsed.project_type !== undefined) updates.project_type = parsed.project_type
  if (parsed.budget_range !== undefined) updates.budget_range = parsed.budget_range
  if (parsed.timeline_preference !== undefined) updates.timeline_preference = parsed.timeline_preference
  if (parsed.tags !== undefined) updates.tags = parsed.tags
  if (parsed.notes !== undefined) updates.notes = parsed.notes
  if (parsed.lost_reason !== undefined) updates.lost_reason = parsed.lost_reason
  if (parsed.next_follow_up_at !== undefined) updates.next_follow_up_at = parsed.next_follow_up_at
  applyTerminalStatusDates(updates, parsed.status, existing.status as ProspectStatus)

  const { data, error } = await supabase
    .from("prospects")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .select(prospectSelect)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update prospect: ${error?.message}`)
  }

  if (parsed.status && parsed.status !== existing.status) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "prospect_status_changed",
      entityType: "prospect",
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
    entityType: "prospect",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  const contacts = await listProspectContacts(prospectId, resolvedOrgId)
  return mapProspect(data, contacts)
}

export async function deleteProspect({
  prospectId,
  orgId,
}: {
  prospectId: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("prospects")
    .select(prospectSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect not found")
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("prospect_id", prospectId)
    .maybeSingle()

  if (project) {
    throw new Error("This prospect has a project. Delete or unlink the project first.")
  }

  // prospect_contacts cascade via FK; estimates/bid_packages/files set prospect_id null.
  const { error } = await supabase
    .from("prospects")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)

  if (error) {
    throw new Error(`Failed to delete prospect: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "prospect_deleted",
    entityType: "prospect",
    entityId: prospectId,
    payload: { name: existing.name },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "prospect",
    entityId: prospectId,
    before: existing,
  })
}

export async function listProspectContacts(prospectId: string, orgId?: string): Promise<ProspectContact[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("prospect_contacts")
    .select(prospectContactSelect)
    .eq("org_id", resolvedOrgId)
    .eq("prospect_id", prospectId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to list prospect contacts: ${error.message}`)
  }

  return (data ?? []).map(mapProspectContact)
}

export async function createProspectContact({
  prospectId,
  input,
  orgId,
}: {
  prospectId: string
  input: ProspectContactInput
  orgId?: string
}): Promise<ProspectContact> {
  const parsed = prospectContactInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: prospect, error: prospectError } = await supabase
    .from("prospects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", prospectId)
    .maybeSingle()

  if (prospectError || !prospect) {
    throw new Error("Prospect not found")
  }

  await setPrimaryContactIfNeeded({
    supabase,
    orgId: resolvedOrgId,
    prospectId,
    isPrimary: parsed.is_primary,
  })

  const { data, error } = await supabase
    .from("prospect_contacts")
    .insert({
      org_id: resolvedOrgId,
      prospect_id: prospectId,
      full_name: parsed.full_name,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      role: parsed.role ?? null,
      company_name: parsed.company_name ?? null,
      is_primary: parsed.is_primary ?? false,
      metadata: parsed.metadata ?? {},
    })
    .select(prospectContactSelect)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create prospect contact: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "prospect_contact",
    entityId: data.id as string,
    after: data,
  })

  return mapProspectContact(data)
}

export async function updateProspectContact({
  contactId,
  input,
  orgId,
}: {
  contactId: string
  input: UpdateProspectContactInput
  orgId?: string
}): Promise<ProspectContact> {
  const parsed = updateProspectContactInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("prospect_contacts")
    .select(prospectContactSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect contact not found")
  }

  await setPrimaryContactIfNeeded({
    supabase,
    orgId: resolvedOrgId,
    prospectId: existing.prospect_id as string,
    contactId,
    isPrimary: parsed.is_primary,
  })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.full_name !== undefined) updates.full_name = parsed.full_name
  if (parsed.email !== undefined) updates.email = parsed.email
  if (parsed.phone !== undefined) updates.phone = parsed.phone
  if (parsed.role !== undefined) updates.role = parsed.role
  if (parsed.company_name !== undefined) updates.company_name = parsed.company_name
  if (parsed.is_primary !== undefined) updates.is_primary = parsed.is_primary
  if (parsed.metadata !== undefined) updates.metadata = parsed.metadata
  if (parsed.contact_id !== undefined) updates.contact_id = parsed.contact_id
  if (parsed.promoted_contact_id !== undefined) updates.promoted_contact_id = parsed.promoted_contact_id

  const { data, error } = await supabase
    .from("prospect_contacts")
    .update(updates)
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .select(prospectContactSelect)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update prospect contact: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "prospect_contact",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapProspectContact(data)
}

/**
 * Removes a secondary contact from a lead — the co-op agent who turned out not to
 * be involved, the spouse entered twice.
 *
 * Refuses the primary contact: that is the buyer, and a deal without a buyer is
 * not a state the board can render. If the contact was promoted into the org
 * directory the directory record stays — dropping a broker from one deal is not
 * the same as deleting them from the company.
 */
export async function deleteProspectContact({
  contactId,
  orgId,
}: {
  contactId: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("prospect_contacts")
    .select(prospectContactSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Prospect contact not found")
  }
  if (existing.is_primary) {
    throw new Error("The primary contact cannot be removed — edit the buyer instead")
  }

  const { error } = await supabase
    .from("prospect_contacts")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)

  if (error) {
    throw new Error(`Failed to delete prospect contact: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "prospect_contact",
    entityId: contactId,
    before: existing,
  })
}
