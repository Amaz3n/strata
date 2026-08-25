import type { SupabaseClient } from "@supabase/supabase-js"

import type { Company, Contact, ContactCompanyLink, ContactType } from "@/lib/types"
import {
  contactCompanyLinkSchema,
  contactFiltersSchema,
  contactInputSchema,
  contactTypeEnum,
  contactUpdateSchema,
  type ContactCompanyLinkInput,
  type ContactFilters,
  type ContactInput,
} from "@/lib/validation/contacts"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission } from "@/lib/services/permissions"
import {
  assignPartyRoleWithClient,
  endPartyRolesForPartyWithClient,
  getPartyRolesWithClient,
  revivePartyRolesEndedAtWithClient,
} from "@/lib/services/party-roles"
import { resolvePartyCapabilities } from "@/lib/directory/roles"
import {
  DIRECTORY_READ_PERMISSIONS,
  DIRECTORY_WRITE_PERMISSIONS,
} from "@/lib/directory/permissions"
import { NotFoundError } from "@/lib/not-found-error"

function mapCompany(row: any): Company {
  const metadata = row?.metadata ?? {}
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    company_type: row.company_type ?? "other",
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    address: row.address ?? undefined,
    trade: metadata.trade ?? undefined,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? undefined,
  }
}

function mapContact(row: any): Contact {
  const metadata = row?.metadata ?? {}
  const companies: ContactCompanyLink[] =
    row.contact_company_links?.map((link: any) => ({
      id: link.id,
      org_id: link.org_id ?? row.org_id,
      contact_id: link.contact_id ?? row.id,
      company_id: link.company_id,
      relationship: link.relationship ?? undefined,
      created_at: link.created_at ?? row.created_at,
    })) ?? []

  return {
    id: row.id,
    org_id: row.org_id,
    full_name: row.full_name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    role: row.role ?? undefined,
    contact_type: row.contact_type ?? "subcontractor",
    primary_company_id: row.primary_company_id ?? undefined,
    primary_company: row.primary_company ? mapCompany(row.primary_company) : undefined,
    has_portal_access: metadata.has_portal_access ?? false,
    preferred_contact_method: metadata.preferred_contact_method ?? undefined,
    notes: metadata.notes ?? undefined,
    external_crm_id: row.external_crm_id ?? undefined,
    crm_source: row.crm_source ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    companies,
  }
}

export async function listContacts(orgId?: string, filters?: ContactFilters): Promise<Contact[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_READ_PERMISSIONS, {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
  return listContactsWithClient(supabase, resolvedOrgId, filters)
}

/**
 * Contacts eligible as invoice recipients: parties whose CURRENT roles carry a
 * client (receivables) or design relationship. Pure role math — never
 * `contact_type`, which is a legacy column and not the source of truth.
 */
export async function listBillableContacts(orgId?: string): Promise<Contact[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_READ_PERMISSIONS, {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
  const contacts = await listContactsWithClient(supabase, resolvedOrgId)
  if (contacts.length === 0) return contacts
  const roleMap = await getPartyRolesWithClient(supabase, resolvedOrgId, {
    contactIds: contacts.map((contact) => contact.id),
  })
  return contacts.filter((contact) => {
    const capabilities = resolvePartyCapabilities(roleMap.get(contact.id) ?? [])
    return capabilities.isClient || capabilities.isDesign
  })
}

async function resolveContactIdsForCompany(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("contact_company_links")
    .select("contact_id")
    .eq("org_id", orgId)
    .eq("company_id", companyId)

  if (error) {
    throw new Error(`Failed to filter contacts by company: ${error.message}`)
  }

  return Array.from(new Set((data ?? []).map((row) => row.contact_id)))
}

export async function listContactsWithClient(
  supabase: SupabaseClient,
  orgId: string,
  filters?: ContactFilters,
): Promise<Contact[]> {
  const parsedFilters = contactFiltersSchema.parse(filters ?? undefined) ?? {}

  let contactIdsFilter: string[] | undefined
  if (parsedFilters.company_id) {
    contactIdsFilter = await resolveContactIdsForCompany(supabase, orgId, parsedFilters.company_id)
    if (contactIdsFilter.length === 0) return []
  }

  let query = supabase
    .from("contacts")
    .select(
      `
      id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at,
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, metadata),
      contact_company_links(id, org_id, contact_id, company_id, relationship, created_at)
    `,
    )
    .eq("org_id", orgId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })

  if (parsedFilters.contact_type) {
    query = query.eq("contact_type", parsedFilters.contact_type)
  }
  if (contactIdsFilter) {
    query = query.in("id", contactIdsFilter)
  }
  if (parsedFilters.search) {
    query = query.or(
      ["full_name.ilike.%{search}%", "email.ilike.%{search}%"].join(",").replaceAll("{search}", parsedFilters.search),
    )
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list contacts: ${error.message}`)
  }

  return (data ?? []).map(mapContact)
}

export async function getContact(contactId: string, orgId?: string): Promise<Contact & { company_details: Company[] }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_READ_PERMISSIONS, {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data, error } = await supabase
    .from("contacts")
    .select(
      `
      id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at,
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, metadata),
      contact_company_links(
        id, org_id, contact_id, company_id, relationship, created_at,
        companies:company_id (id, org_id, name, company_type, phone, email, website, address, metadata)
      )
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load contact: ${error.message}`)
  }
  if (!data) {
    throw new NotFoundError("Contact not found")
  }

  const companyRecords: Company[] =
    data.contact_company_links?.map((link: any) => mapCompany({ ...link.companies, org_id: resolvedOrgId })) ?? []

  return {
    ...mapContact(data),
    company_details: companyRecords,
  }
}

/**
 * The role a create is recording, and the legacy column that has to keep
 * agreeing with it.
 *
 * `party_roles` is the source of truth, but `contacts.contact_type` is still
 * read until its gated drop. Its CHECK accepts every seeded person role except
 * `other`, so a role it cannot express — `other`, or one an org added itself —
 * writes null rather than a neighbouring value that would read as a lie.
 */
function resolveContactRole(input: ContactInput): {
  roleKey: string
  legacyType: ContactType | null
} {
  const roleKey = input.role_key ?? input.contact_type ?? "subcontractor"
  const legacy = contactTypeEnum.safeParse(roleKey)
  return { roleKey, legacyType: legacy.success ? legacy.data : null }
}

function buildContactInsert(input: ContactInput, orgId: string, legacyType: ContactType | null) {
  return {
    org_id: orgId,
    primary_company_id: input.primary_company_id ?? null,
    full_name: input.full_name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ? { formatted: input.address } : null,
    role: input.role ?? null,
    contact_type: legacyType,
    external_crm_id: input.external_crm_id ?? null,
    crm_source: input.crm_source ?? null,
    metadata: {
      has_portal_access: input.has_portal_access ?? false,
      preferred_contact_method: input.preferred_contact_method,
      notes: input.notes,
    },
  }
}

export async function createContact({ input, orgId }: { input: ContactInput; orgId?: string }): Promise<Contact> {
  const parsed = contactInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { roleKey, legacyType } = resolveContactRole(parsed)
  const { data, error } = await supabase
    .from("contacts")
    .insert(buildContactInsert(parsed, resolvedOrgId, legacyType))
    .select(
      `
      id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at,
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, metadata),
      contact_company_links(id, org_id, contact_id, company_id, relationship, created_at)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create contact: ${error?.message}`)
  }

  if (parsed.primary_company_id) {
    const { error: linkError } = await supabase
      .from("contact_company_links")
      .upsert(
        {
          org_id: resolvedOrgId,
          contact_id: data.id,
          company_id: parsed.primary_company_id,
          relationship: "primary",
          is_primary: true,
          title: parsed.role ?? null,
        },
        { onConflict: "contact_id,company_id" },
      )

    if (linkError) {
      throw new Error(`Failed to link contact to primary company: ${linkError.message}`)
    }
  }

  // What this person is to the org is a role. The type column is still written
  // for readers that have not moved yet; this row is the source of truth.
  await assignPartyRoleWithClient(supabase, resolvedOrgId, userId, {
    kind: "contact",
    partyId: data.id as string,
    roleKey,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "contact_created",
    entityType: "contact",
    entityId: data.id as string,
    payload: { name: data.full_name, contact_type: data.contact_type },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "contact",
    entityId: data.id as string,
    after: data,
  })

  return mapContact(data)
}

export async function updateContact({
  contactId,
  input,
  orgId,
}: {
  contactId: string
  input: Partial<ContactInput>
  orgId?: string
}): Promise<Contact> {
  const parsed = contactUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select(
      "id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at",
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Contact not found")
  }

  const previousPrimaryCompanyId = existing.primary_company_id ?? undefined
  const nextPrimaryCompanyId = parsed.primary_company_id ?? existing.primary_company_id ?? undefined

  const metadata = {
    ...(existing.metadata ?? {}),
    has_portal_access:
      typeof parsed.has_portal_access === "boolean" ? parsed.has_portal_access : existing.metadata?.has_portal_access,
    preferred_contact_method: parsed.preferred_contact_method ?? existing.metadata?.preferred_contact_method,
    notes: parsed.notes ?? existing.metadata?.notes,
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({
      full_name: parsed.full_name ?? existing.full_name,
      email: parsed.email ?? existing.email,
      phone: parsed.phone ?? existing.phone,
      address:
        typeof parsed.address === "string"
          ? parsed.address.trim()
            ? { formatted: parsed.address.trim() }
            : null
          : (existing.address ?? null),
      role: parsed.role ?? existing.role,
      contact_type: parsed.contact_type ?? existing.contact_type,
      primary_company_id: parsed.primary_company_id ?? existing.primary_company_id,
      external_crm_id: parsed.external_crm_id ?? existing.external_crm_id,
      crm_source: parsed.crm_source ?? existing.crm_source,
      metadata,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .select(
      `
      id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at,
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, metadata),
      contact_company_links(id, org_id, contact_id, company_id, relationship, created_at)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update contact: ${error?.message}`)
  }

  if (nextPrimaryCompanyId) {
    const { error: linkError } = await supabase
      .from("contact_company_links")
      .upsert(
        {
          org_id: resolvedOrgId,
          contact_id: data.id,
          company_id: nextPrimaryCompanyId,
          relationship: "primary",
          is_primary: true,
        },
        { onConflict: "contact_id,company_id" },
      )

    if (linkError) {
      throw new Error(`Failed to link contact to primary company: ${linkError.message}`)
    }
  }

  if (previousPrimaryCompanyId && previousPrimaryCompanyId !== nextPrimaryCompanyId) {
    const { error: unlinkError } = await supabase
      .from("contact_company_links")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("contact_id", data.id)
      .eq("company_id", previousPrimaryCompanyId)
      .eq("relationship", "primary")

    if (unlinkError) {
      throw new Error(`Failed to unlink previous primary company: ${unlinkError.message}`)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "contact_updated",
    entityType: "contact",
    entityId: data.id as string,
    payload: { name: data.full_name, contact_type: data.contact_type },
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

  return mapContact(data)
}

export async function archiveContact(contactId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const [{ count: scheduleCount, error: scheduleError }, { count: taskCount, error: taskError }] = await Promise.all([
    supabase
      .from("schedule_assignments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("contact_id", contactId),
    supabase
      .from("task_assignments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("contact_id", contactId),
  ])

  if (scheduleError || taskError) {
    console.error("Failed to check contact assignments", scheduleError ?? taskError)
  } else if ((scheduleCount ?? 0) + (taskCount ?? 0) > 0) {
    throw new Error("Cannot archive contact while they are assigned to tasks or schedule items")
  }

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, archived_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Contact not found")
  }

  const archivedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from("contacts")
    .update({ archived_at: archivedAt })
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .select("id, org_id, full_name, archived_at")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to archive contact: ${error?.message}`)
  }

  // Same rule as companies: the record leaving the list has to take its
  // relationships with it, or role-based reads keep treating it as live.
  await endPartyRolesForPartyWithClient(supabase, resolvedOrgId, userId, {
    kind: "contact",
    partyId: contactId,
    endedAt: archivedAt,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "contact_archived",
    entityType: "contact",
    entityId: data.id as string,
    payload: { full_name: data.full_name },
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

  return true
}

export async function restoreContact(contactId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, archived_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Contact not found")
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({ archived_at: null })
    .eq("org_id", resolvedOrgId)
    .eq("id", contactId)
    .select("id, org_id, full_name, archived_at")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to restore contact: ${error?.message}`)
  }

  const archivedAt = existing.archived_at as string | null
  if (archivedAt) {
    await revivePartyRolesEndedAtWithClient(supabase, resolvedOrgId, userId, {
      kind: "contact",
      partyId: contactId,
      endedAt: archivedAt,
    })
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "contact_restored",
    entityType: "contact",
    entityId: data.id as string,
    payload: { full_name: data.full_name },
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

  return true
}

export async function linkContactToCompany(input: ContactCompanyLinkInput, orgId?: string) {
  const parsed = contactCompanyLinkSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { error } = await supabase
    .from("contact_company_links")
    .upsert({
      org_id: resolvedOrgId,
      contact_id: parsed.contact_id,
      company_id: parsed.company_id,
      relationship: parsed.relationship ?? null,
    })

  if (error) {
    throw new Error(`Failed to link contact to company: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "contact_company_link",
    entityId: parsed.contact_id,
    after: parsed,
  })

  return true
}

export async function unlinkContactFromCompany({ contactId, companyId, orgId }: { contactId: string; companyId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { error } = await supabase
    .from("contact_company_links")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("contact_id", contactId)
    .eq("company_id", companyId)

  if (error) {
    throw new Error(`Failed to unlink contact from company: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "contact_company_link",
    entityId: contactId,
    before: { contact_id: contactId, company_id: companyId },
    after: null,
  })

  return true
}

/**
 * A person's schedule and task assignments, newest first.
 *
 * Capped and ordered on purpose: these queries had neither, so a
 * long-tenured superintendent's activity tab rendered every assignment they
 * had ever held, in whatever order the database returned them.
 */
const CONTACT_ASSIGNMENT_LIMIT = 100

export async function getContactAssignments(contactId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [scheduleAssignments, taskAssignments] = await Promise.all([
    supabase
      .from("schedule_assignments")
      .select(
        `
        id, project_id, schedule_item_id, role, planned_hours, actual_hours, hourly_rate_cents, confirmed_at, notes, created_at,
        schedule_items(id, name, project_id, start_date, end_date)
      `,
      )
      .eq("org_id", resolvedOrgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(CONTACT_ASSIGNMENT_LIMIT + 1),
    supabase
      .from("task_assignments")
      .select(
        `
        id, task_id, role, due_date, created_at,
        tasks(id, title, project_id, due_date)
      `,
      )
      .eq("org_id", resolvedOrgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(CONTACT_ASSIGNMENT_LIMIT + 1),
  ])

  if (scheduleAssignments.error) {
    throw new Error(`Failed to load schedule assignments: ${scheduleAssignments.error.message}`)
  }
  if (taskAssignments.error) {
    throw new Error(`Failed to load task assignments: ${taskAssignments.error.message}`)
  }

  // One row past the cap is the probe that tells the UI it truncated.
  const scheduleRows = (scheduleAssignments.data ?? []).slice(0, CONTACT_ASSIGNMENT_LIMIT)
  const taskRows = (taskAssignments.data ?? []).slice(0, CONTACT_ASSIGNMENT_LIMIT)
  const scheduleTruncated = (scheduleAssignments.data ?? []).length > CONTACT_ASSIGNMENT_LIMIT
  const tasksTruncated = (taskAssignments.data ?? []).length > CONTACT_ASSIGNMENT_LIMIT

  const projectIds = Array.from(
    new Set(
      [
        ...scheduleRows.map((row: any) => row.project_id),
        ...taskRows.map((row: any) =>
          (Array.isArray(row.tasks) ? row.tasks[0] : row.tasks)?.project_id,
        ),
      ].filter(Boolean),
    ),
  )

  const projectById = new Map<string, { id: string; name: string }>()
  if (projectIds.length > 0) {
    const { data: projects, error: projectsError } = await supabase
      .from("projects")
      .select("id, name")
      .eq("org_id", resolvedOrgId)
      .in("id", projectIds as string[])

    if (projectsError) {
      throw new Error(`Failed to load assignment projects: ${projectsError.message}`)
    }

    for (const project of projects ?? []) {
      projectById.set(project.id as string, {
        id: project.id as string,
        name: project.name as string,
      })
    }
  }

  return {
    limit: CONTACT_ASSIGNMENT_LIMIT,
    scheduleTruncated,
    tasksTruncated,
    schedule: scheduleRows.map((row: any) => ({
      id: row.id,
      project_id: row.project_id,
      schedule_item_id: row.schedule_item_id,
      role: row.role ?? undefined,
      planned_hours: row.planned_hours ?? undefined,
      actual_hours: row.actual_hours ?? undefined,
      hourly_rate_cents: row.hourly_rate_cents ?? undefined,
      confirmed_at: row.confirmed_at ?? undefined,
      notes: row.notes ?? undefined,
      created_at: row.created_at,
      project: row.project_id ? projectById.get(row.project_id) : undefined,
      schedule_item: Array.isArray(row.schedule_items) ? row.schedule_items[0] : row.schedule_items,
    })),
    tasks: taskRows.map((row: any) => ({
      id: row.id,
      task_id: row.task_id,
      role: row.role ?? undefined,
      due_date: row.due_date ?? undefined,
      created_at: row.created_at,
      project: (Array.isArray(row.tasks) ? row.tasks[0] : row.tasks)?.project_id
        ? projectById.get((Array.isArray(row.tasks) ? row.tasks[0] : row.tasks).project_id)
        : undefined,
      task: Array.isArray(row.tasks) ? row.tasks[0] : row.tasks,
    })),
  }
}
