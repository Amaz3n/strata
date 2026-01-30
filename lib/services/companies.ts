import type { SupabaseClient } from "@supabase/supabase-js"

import type { Company, Contact } from "@/lib/types"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema, type CompanyFilters, type CompanyInput } from "@/lib/validation/companies"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { hasPermission, requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { getDefaultComplianceRequirements } from "@/lib/services/compliance"
import { setCompanyRequirements } from "@/lib/services/compliance-documents"

function mapCompany(row: any): Company {
  const metadata = row?.metadata ?? {}
  const contactCount = Array.isArray(row?.contact_company_links) && row.contact_company_links[0]?.count != null ? row.contact_company_links[0].count : undefined

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    company_type: row.company_type ?? "other",
    trade: metadata.trade ?? undefined,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    address: row.address ?? metadata.address ?? undefined,
    license_number: row.license_number ?? metadata.license_number ?? undefined,
    license_expiry: row.license_expiry ?? metadata.license_expiry ?? undefined,
    license_verified: row.license_verified ?? metadata.license_verified ?? undefined,
    insurance_expiry: row.insurance_expiry ?? metadata.insurance_expiry ?? undefined,
    insurance_provider: row.insurance_provider ?? metadata.insurance_provider ?? undefined,
    insurance_document_id: row.insurance_document_id ?? metadata.insurance_document_id ?? undefined,
    w9_on_file: row.w9_on_file ?? metadata.w9_on_file ?? undefined,
    w9_file_id: row.w9_file_id ?? metadata.w9_file_id ?? undefined,
    prequalified: row.prequalified ?? metadata.prequalified ?? undefined,
    prequalified_at: row.prequalified_at ?? metadata.prequalified_at ?? undefined,
    rating: row.rating ?? metadata.rating ?? undefined,
    default_payment_terms: row.default_payment_terms ?? metadata.default_payment_terms ?? undefined,
    internal_notes: row.internal_notes ?? metadata.internal_notes ?? undefined,
    notes: row.notes ?? metadata.notes ?? undefined,
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

export async function listCompanies(orgId?: string, filtersOrContext?: CompanyFilters | OrgServiceContext, context?: OrgServiceContext): Promise<Company[]> {
  // Handle overloaded parameters
  let filters: CompanyFilters | undefined
  let actualContext: OrgServiceContext | undefined

  if (context) {
    // New signature: (orgId?, filters?, context?)
    filters = filtersOrContext as CompanyFilters
    actualContext = context
  } else if (filtersOrContext && typeof filtersOrContext === 'object' && 'supabase' in filtersOrContext) {
    // Context passed as second parameter
    actualContext = filtersOrContext as OrgServiceContext
  } else {
    // Filters passed as second parameter
    filters = filtersOrContext as CompanyFilters
  }

  const { supabase, orgId: resolvedOrgId, userId } = actualContext || await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
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
      id, org_id, name, company_type, phone, email, website, address,
      license_number, license_expiry, license_verified, insurance_expiry, insurance_provider, insurance_document_id,
      w9_on_file, w9_file_id, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes,
      metadata, created_at, updated_at,
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
    query = query.eq("metadata->>trade", parsedFilters.trade)
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("companies")
    .select(
      `
      id, org_id, name, company_type, phone, email, website, address,
      license_number, license_expiry, license_verified, insurance_expiry, insurance_provider, insurance_document_id,
      w9_on_file, w9_file_id, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes,
      metadata, created_at, updated_at,
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

  const primaryContactQuery = await supabase
    .from("contacts")
    .select(
      "id, org_id, full_name, email, phone, role, contact_type, primary_company_id, metadata, created_at, updated_at",
    )
    .eq("org_id", resolvedOrgId)
    .eq("primary_company_id", companyId)

  if (primaryContactQuery.error) {
    throw new Error(`Failed to load company contacts: ${primaryContactQuery.error.message}`)
  }

  const contacts =
    [
      ...(data.contact_company_links?.map((link: any) =>
        mapContact({
          ...link.contact,
          relationship: link.relationship,
        }),
      ) ?? []),
      ...(primaryContactQuery.data ?? []).map((row: any) => mapContact(row)),
    ]

  const deduped = new Map<string, Contact>()
  for (const contact of contacts) {
    if (!deduped.has(contact.id)) {
      deduped.set(contact.id, contact)
    }
  }

  return {
    ...mapCompany(data),
    contacts: Array.from(deduped.values()),
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
    license_number: input.license_number ?? null,
    license_expiry: input.license_expiry ?? null,
    license_verified: input.license_verified ?? false,
    insurance_expiry: input.insurance_expiry ?? null,
    insurance_provider: input.insurance_provider ?? null,
    insurance_document_id: input.insurance_document_id ?? null,
    w9_on_file: input.w9_on_file ?? false,
    w9_file_id: input.w9_file_id ?? null,
    prequalified: input.prequalified ?? false,
    prequalified_at: input.prequalified_at ?? null,
    rating: input.rating ?? null,
    default_payment_terms: input.default_payment_terms ?? null,
    internal_notes: input.internal_notes ?? null,
    notes: input.notes ?? null,
    metadata: {
      trade: input.trade,
      license_number: input.license_number,
      license_expiry: input.license_expiry,
      license_verified: input.license_verified,
      insurance_expiry: input.insurance_expiry,
      insurance_provider: input.insurance_provider,
      insurance_document_id: input.insurance_document_id,
      w9_on_file: input.w9_on_file,
      w9_file_id: input.w9_file_id,
      prequalified: input.prequalified,
      prequalified_at: input.prequalified_at,
      rating: input.rating,
      default_payment_terms: input.default_payment_terms,
      internal_notes: input.internal_notes,
      notes: input.notes,
    },
  }
}

export async function createCompany({ input, orgId }: { input: CompanyInput; orgId?: string }): Promise<Company> {
  const parsed = companyInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("companies")
    .insert(buildCompanyInsert(parsed, resolvedOrgId))
    .select(
      "id, org_id, name, company_type, phone, email, website, address, license_number, license_expiry, license_verified, insurance_expiry, insurance_provider, insurance_document_id, w9_on_file, w9_file_id, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, metadata, created_at, updated_at, contact_company_links(count)",
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

  // Auto-apply org default compliance requirements for new subs/suppliers.
  if (data.company_type === "subcontractor" || data.company_type === "supplier") {
    const defaults = await getDefaultComplianceRequirements(resolvedOrgId).catch(() => [])
    if (defaults.length > 0) {
      await setCompanyRequirements({
        companyId: data.id as string,
        requirements: defaults.map((d) => ({
          document_type_id: d.document_type_id,
          is_required: true,
          min_coverage_cents: d.min_coverage_cents,
          notes: d.notes,
        })),
        orgId: resolvedOrgId,
      }).catch(() => {
        // Best-effort: company creation should succeed even if defaults fail.
      })
    }
  }

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
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("companies")
    .select("id, org_id, name, company_type, phone, email, website, address, license_number, license_expiry, license_verified, insurance_expiry, insurance_provider, insurance_document_id, w9_on_file, w9_file_id, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, metadata, created_at, updated_at")
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
    license_expiry: parsed.license_expiry ?? existing.metadata?.license_expiry,
    license_verified: typeof parsed.license_verified === "boolean" ? parsed.license_verified : existing.metadata?.license_verified,
    insurance_expiry: parsed.insurance_expiry ?? existing.metadata?.insurance_expiry,
    insurance_provider: parsed.insurance_provider ?? existing.metadata?.insurance_provider,
    insurance_document_id: parsed.insurance_document_id ?? existing.metadata?.insurance_document_id,
    w9_on_file: typeof parsed.w9_on_file === "boolean" ? parsed.w9_on_file : existing.metadata?.w9_on_file,
    w9_file_id: parsed.w9_file_id ?? existing.metadata?.w9_file_id,
    prequalified: typeof parsed.prequalified === "boolean" ? parsed.prequalified : existing.metadata?.prequalified,
    prequalified_at: parsed.prequalified_at ?? existing.metadata?.prequalified_at,
    rating: parsed.rating ?? existing.metadata?.rating,
    default_payment_terms: parsed.default_payment_terms ?? existing.metadata?.default_payment_terms,
    internal_notes: parsed.internal_notes ?? existing.metadata?.internal_notes,
    notes: parsed.notes ?? existing.metadata?.notes,
  }

  if (typeof parsed.prequalified === "boolean" && parsed.prequalified && !existing.metadata?.prequalified && !parsed.prequalified_at) {
    metadata.prequalified_at = new Date().toISOString()
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
      license_number: parsed.license_number ?? existing.license_number,
      license_expiry: parsed.license_expiry ?? existing.license_expiry,
      license_verified: typeof parsed.license_verified === "boolean" ? parsed.license_verified : existing.license_verified,
      insurance_expiry: parsed.insurance_expiry ?? existing.insurance_expiry,
      insurance_provider: parsed.insurance_provider ?? existing.insurance_provider,
      insurance_document_id: parsed.insurance_document_id ?? existing.insurance_document_id,
      w9_on_file: typeof parsed.w9_on_file === "boolean" ? parsed.w9_on_file : existing.w9_on_file,
      w9_file_id: parsed.w9_file_id ?? existing.w9_file_id,
      prequalified: typeof parsed.prequalified === "boolean" ? parsed.prequalified : existing.prequalified,
      prequalified_at: parsed.prequalified_at ?? existing.prequalified_at,
      rating: parsed.rating ?? existing.rating,
      default_payment_terms: parsed.default_payment_terms ?? existing.default_payment_terms,
      internal_notes: parsed.internal_notes ?? existing.internal_notes,
      notes: parsed.notes ?? existing.notes,
      metadata,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select(
      "id, org_id, name, company_type, phone, email, website, address, license_number, license_expiry, license_verified, insurance_expiry, insurance_provider, insurance_document_id, w9_on_file, w9_file_id, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, metadata, created_at, updated_at, contact_company_links(count)",
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
  const canArchive =
    (await hasPermission("org.admin", { supabase, orgId: resolvedOrgId, userId })) ||
    (await hasPermission("members.manage", { supabase, orgId: resolvedOrgId, userId }))

  if (!canArchive) {
    throw new Error("Missing permission: org.admin")
  }

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
  const [{ data: linked, error: linkError }, { data: primaryContacts, error: primaryError }] = await Promise.all([
    supabase
      .from("contact_company_links")
      .select(
        `
        id, relationship, created_at,
        contacts!inner(id, org_id, full_name, email, phone, role, contact_type, primary_company_id, metadata, created_at, updated_at)
      `,
      )
      .eq("org_id", resolvedOrgId)
      .eq("company_id", companyId),
    supabase
      .from("contacts")
      .select(
        "id, org_id, full_name, email, phone, role, contact_type, primary_company_id, metadata, created_at, updated_at",
      )
      .eq("org_id", resolvedOrgId)
      .eq("primary_company_id", companyId),
  ])

  if (linkError) {
    throw new Error(`Failed to load company contacts: ${linkError.message}`)
  }
  if (primaryError) {
    throw new Error(`Failed to load primary company contacts: ${primaryError.message}`)
  }

  const combined = [
    ...(linked ?? []).map((link: any) =>
      mapContact({
        ...link.contacts,
        relationship: link.relationship,
      }),
    ),
    ...(primaryContacts ?? []).map((row: any) => mapContact(row)),
  ]

  const deduped = new Map<string, Contact>()
  for (const contact of combined) {
    if (!deduped.has(contact.id)) {
      deduped.set(contact.id, contact)
    }
  }

  return Array.from(deduped.values())
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
