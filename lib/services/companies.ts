import type { SupabaseClient } from "@supabase/supabase-js"

import type { Company, Contact } from "@/lib/types"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema, type CompanyFilters, type CompanyInput } from "@/lib/validation/companies"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"

function mapCompany(row: any): Company {
  const metadata = row?.metadata ?? {}
  const contactCount = Array.isArray(row?.contact_company_links) && row.contact_company_links[0]?.count != null ? row.contact_company_links[0].count : undefined

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    company_type: row.company_type ?? "other",
    trade: metadata.trade ?? row.trade ?? undefined,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    address: row.address ?? metadata.address ?? undefined,
    license_number: metadata.license_number ?? undefined,
    insurance_expiry: metadata.insurance_expiry ?? undefined,
    insurance_document_id: metadata.insurance_document_id ?? undefined,
    notes: metadata.notes ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    contact_count: contactCount,
    project_count: row.project_count ?? undefined,
  }
}

function mapContact(row: any): Contact {
  const metadata = row?.metadata ?? {}
  return {
    id: row.id,
    org_id: row.org_id,
    full_name: row.full_name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    role: row.role ?? undefined,
    contact_type: row.contact_type ?? "subcontractor",
    primary_company_id: row.primary_company_id ?? undefined,
    has_portal_access: metadata.has_portal_access ?? false,
    preferred_contact_method: metadata.preferred_contact_method ?? undefined,
    notes: metadata.notes ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  }
}

export async function listCompanies(orgId?: string, filters?: CompanyFilters): Promise<Company[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listCompaniesWithClient(supabase, resolvedOrgId, filters)
}

export async function listCompaniesWithClient(
  supabase: SupabaseClient,
  orgId: string,
  filters?: CompanyFilters,
): Promise<Company[]> {
  const parsedFilters = companyFiltersSchema.parse(filters ?? undefined) ?? {}

  let query = supabase
    .from("companies")
    .select(
      `
      id, org_id, name, company_type, phone, email, website, address, metadata, created_at, updated_at,
      contact_company_links(count)
    `,
    )
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null)
    .order("created_at", { ascending: false })

  if (parsedFilters.company_type) {
    query = query.eq("company_type", parsedFilters.company_type)
  }
  if (parsedFilters.trade) {
    query = query.contains("metadata", { trade: parsedFilters.trade })
  }
  if (parsedFilters.search) {
    query = query.ilike("name", `%${parsedFilters.search}%`)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list companies: ${error.message}`)
  }

  return (data ?? []).map(mapCompany)
}

export async function getCompany(companyId: string, orgId?: string): Promise<Company & { contacts: Contact[] }> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("companies")
    .select(
      `
      id, org_id, name, company_type, phone, email, website, address, metadata, created_at, updated_at,
      contact_company_links (
        id, relationship, created_at,
        contact:contacts (
          id, org_id, full_name, email, phone, role, contact_type, primary_company_id, metadata, created_at, updated_at
        )
      )
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Company not found")
  }

  const contacts =
    data.contact_company_links?.map((link: any) =>
      mapContact({
        ...link.contact,
        relationship: link.relationship,
      }),
    ) ?? []

  return {
    ...mapCompany(data),
    contacts,
  }
}

function buildCompanyInsert(input: CompanyInput, orgId: string) {
  return {
    org_id: orgId,
    name: input.name,
    company_type: input.company_type,
    phone: input.phone ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
    address: input.address ?? null,
    metadata: {
      trade: input.trade,
      license_number: input.license_number,
      insurance_expiry: input.insurance_expiry,
      insurance_document_id: input.insurance_document_id,
      notes: input.notes,
    },
  }
}

export async function createCompany({ input, orgId }: { input: CompanyInput; orgId?: string }): Promise<Company> {
  const parsed = companyInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("companies")
    .insert(buildCompanyInsert(parsed, resolvedOrgId))
    .select(
      "id, org_id, name, company_type, phone, email, website, address, metadata, created_at, updated_at, contact_company_links(count)",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create company: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "company_created",
    entityType: "company",
    entityId: data.id as string,
    payload: { name: data.name, company_type: data.company_type },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "company",
    entityId: data.id as string,
    after: data,
  })

  return mapCompany(data)
}

export async function updateCompany({
  companyId,
  input,
  orgId,
}: {
  companyId: string
  input: Partial<CompanyInput>
  orgId?: string
}): Promise<Company> {
  const parsed = companyUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("companies")
    .select("id, org_id, name, company_type, phone, email, website, address, metadata, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Company not found")
  }

  const metadata = {
    ...(existing.metadata ?? {}),
    trade: parsed.trade ?? existing.metadata?.trade,
    license_number: parsed.license_number ?? existing.metadata?.license_number,
    insurance_expiry: parsed.insurance_expiry ?? existing.metadata?.insurance_expiry,
    insurance_document_id: parsed.insurance_document_id ?? existing.metadata?.insurance_document_id,
    notes: parsed.notes ?? existing.metadata?.notes,
  }

  const { data, error } = await supabase
    .from("companies")
    .update({
      name: parsed.name ?? existing.name,
      company_type: parsed.company_type ?? existing.company_type,
      phone: parsed.phone ?? existing.phone,
      email: parsed.email ?? existing.email,
      website: parsed.website ?? existing.website,
      address: parsed.address ?? existing.address,
      metadata,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select(
      "id, org_id, name, company_type, phone, email, website, address, metadata, created_at, updated_at, contact_company_links(count)",
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update company: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "company_updated",
    entityType: "company",
    entityId: data.id as string,
    payload: { name: data.name, company_type: data.company_type },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "company",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return mapCompany(data)
}

export async function archiveCompany(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Prevent archiving if there are assignments
  const { count, error: assignmentError } = await supabase
    .from("schedule_assignments")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (assignmentError) {
    console.error("Unable to check company assignments", assignmentError)
  } else if ((count ?? 0) > 0) {
    throw new Error("Cannot archive company while it has active schedule assignments")
  }

  const { data: existing, error: fetchError } = await supabase
    .from("companies")
    .select("id, org_id, name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Company not found")
  }

  const { data, error } = await supabase
    .from("companies")
    .update({ metadata: { ...(existing.metadata ?? {}), archived_at: new Date().toISOString() } })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select("id, org_id, name, metadata")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to archive company: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "company",
    entityId: data.id as string,
    before: null,
    after: data,
  })

  return true
}

export async function getCompanyContacts(companyId: string, orgId?: string): Promise<Contact[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("contact_company_links")
    .select(
      `
      id, relationship, created_at,
      contacts!inner(id, org_id, full_name, email, phone, role, contact_type, primary_company_id, metadata, created_at, updated_at)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (error) {
    throw new Error(`Failed to load company contacts: ${error.message}`)
  }

  return (data ?? []).map((link: any) =>
    mapContact({
      ...link.contacts,
      relationship: link.relationship,
    }),
  )
}

export async function getCompanyProjects(
  companyId: string,
  orgId?: string,
): Promise<{ id: string; name: string }[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: assignments, error: assignmentError } = await supabase
    .from("schedule_assignments")
    .select("project_id")
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (assignmentError) {
    throw new Error(`Failed to load company projects: ${assignmentError.message}`)
  }

  const projectIds = Array.from(new Set((assignments ?? []).map((a) => a.project_id).filter(Boolean)))
  if (projectIds.length === 0) return []

  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", resolvedOrgId)
    .in("id", projectIds as string[])

  if (error) {
    throw new Error(`Failed to load projects for company: ${error.message}`)
  }

  return projects ?? []
}
