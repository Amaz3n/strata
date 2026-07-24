import type { SupabaseClient } from "@supabase/supabase-js"

import type { Company, Contact } from "@/lib/types"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema, type CompanyFilters, type CompanyInput } from "@/lib/validation/companies"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireAnyPermission } from "@/lib/services/permissions"
import { requireAuthorization } from "@/lib/services/authorization"
import { getDefaultComplianceRequirements } from "@/lib/services/compliance"
import { setCompanyRequirements } from "@/lib/services/compliance-documents"
import { listInvoices } from "@/lib/services/invoices"
import { listProjects } from "@/lib/services/projects"

export interface ClientCompanyReceivableProject {
  project_id: string
  project_name: string
  contract_value_cents: number
  invoiced_cents: number
  collected_cents: number
  outstanding_cents: number
  invoice_count: number
  last_activity?: string
}

export interface ClientCompanyReceivablesSummary {
  contract_value_cents: number
  invoiced_cents: number
  collected_cents: number
  outstanding_cents: number
  invoice_count: number
  can_view_invoices: boolean
  projects: ClientCompanyReceivableProject[]
}

export interface VendorFinancialSummary {
  committed_cents: number
  billed_cents: number
  paid_cents: number
  commitment_count: number
  bill_count: number
  trailing_days: number
  can_view_commitments: boolean
  can_view_bills: boolean
}

const emptyClientCompanyReceivablesSummary: ClientCompanyReceivablesSummary = {
  contract_value_cents: 0,
  invoiced_cents: 0,
  collected_cents: 0,
  outstanding_cents: 0,
  invoice_count: 0,
  can_view_invoices: true,
  projects: [],
}

const emptyVendorFinancialSummary = (trailingDays: number): VendorFinancialSummary => ({
  committed_cents: 0,
  billed_cents: 0,
  paid_cents: 0,
  commitment_count: 0,
  bill_count: 0,
  trailing_days: trailingDays,
  can_view_commitments: false,
  can_view_bills: false,
})

export type CompanyAccountingLink = {
  connection_id: string
  provider: string
  external_id: string
  external_name: string | null
  last_synced_at: string | null
  status: string
  metadata: Record<string, unknown> | null
}

function mapCompany(row: any, accountingLink?: CompanyAccountingLink | null): Company {
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
    prequalified: row.prequalified ?? metadata.prequalified ?? undefined,
    prequalified_at: row.prequalified_at ?? metadata.prequalified_at ?? undefined,
    rating: row.rating ?? metadata.rating ?? undefined,
    default_payment_terms: row.default_payment_terms ?? metadata.default_payment_terms ?? undefined,
    internal_notes: row.internal_notes ?? metadata.internal_notes ?? undefined,
    notes: row.notes ?? metadata.notes ?? undefined,
    qbo_vendor_id: accountingLink?.external_id || undefined,
    qbo_vendor_name: accountingLink?.external_name ?? (accountingLink?.metadata?.display_name as string | undefined) ?? undefined,
    qbo_vendor_synced_at: accountingLink?.last_synced_at ?? undefined,
    qbo_vendor_sync_status: accountingLink?.status ?? undefined,
    tax_id_last4: row.tax_id_last4 ?? undefined,
    tax_entity_type: row.tax_entity_type ?? undefined,
    is_1099_eligible: row.is_1099_eligible ?? undefined,
    w9_file_id: row.w9_file_id ?? undefined,
    w9_received_at: row.w9_received_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    contact_count: contactCount,
    project_count: row.project_count ?? undefined,
  }
}

export async function getCompanyAccountingLinks(supabase: SupabaseClient, orgId: string, companyIds: string[]) {
  const ids = Array.from(new Set(companyIds.filter(Boolean)))
  if (ids.length === 0) return new Map<string, CompanyAccountingLink>()
  const { data, error } = await supabase
    .from("accounting_counterparty_links")
    .select("entity_id,connection_id,provider,external_id,external_name,last_synced_at,status,metadata")
    .eq("org_id", orgId)
    .eq("role", "vendor")
    .eq("entity_type", "company")
    .in("entity_id", ids)
    .order("last_synced_at", { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to load company accounting links: ${error.message}`)
  const links = new Map<string, CompanyAccountingLink>()
  for (const row of data ?? []) {
    if (!links.has(row.entity_id)) links.set(row.entity_id, row as CompanyAccountingLink)
  }
  return links
}

async function mapCompaniesWithAccounting(supabase: SupabaseClient, orgId: string, rows: any[]) {
  const links = await getCompanyAccountingLinks(supabase, orgId, rows.map((row) => row.id))
  return rows.map((row) => mapCompany(row, links.get(row.id)))
}

export async function saveCompanyAccountingVendorLink(input: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  externalId: string
  displayName: string
  status?: "synced" | "needs_review" | "error"
  connectionId?: string | null
}) {
  let connectionId = input.connectionId ?? null
  if (!connectionId) {
    const { data: mapping } = await input.supabase
      .from("accounting_entity_map")
      .select("connection_id")
      .eq("org_id", input.orgId)
      .is("project_id", null)
      .is("community_id", null)
      .is("division_id", null)
      .maybeSingle()
    connectionId = mapping?.connection_id ?? null
  }
  if (!connectionId) throw new Error("No active accounting connection is available for this vendor link")
  const { data: connection } = await input.supabase.from("accounting_connections")
    .select("provider").eq("org_id", input.orgId).eq("id", connectionId).eq("status", "active").maybeSingle()
  if (!connection) throw new Error("Accounting connection not found for this organization")
  const now = new Date().toISOString()
  const { error } = await input.supabase.from("accounting_counterparty_links").upsert({
    org_id: input.orgId,
    connection_id: connectionId,
    provider: connection.provider,
    role: "vendor",
    entity_type: "company",
    entity_id: input.companyId,
    external_id: input.externalId,
    external_name: input.displayName,
    last_synced_at: now,
    status: input.status ?? "synced",
    error_message: null,
    metadata: { display_name: input.displayName },
  }, { onConflict: "org_id,connection_id,role,entity_type,entity_id" })
  if (error) throw new Error(`Failed to save company accounting link: ${error.message}`)

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

function moneyValueToCents(value?: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0
  if (Math.abs(value) > 100000) return Math.round(value)
  return Math.round(value * 100)
}

function latestIsoValue(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1)
}

function normalizeDirectoryName(value?: string | null) {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
  return normalized || undefined
}

async function resolveDirectoryCompanyClassification(
  supabase: SupabaseClient,
  orgId: string,
  companyType: string,
  trade?: string | null,
) {
  const relationshipKey =
    ["subcontractor", "supplier", "client", "architect", "engineer"].includes(companyType)
      ? companyType
      : "other"
  const normalizedTrade = normalizeDirectoryName(trade)

  const [relationshipResult, tradeResult] = await Promise.all([
    supabase
      .from("directory_relationship_types")
      .select("id")
      .eq("org_id", orgId)
      .eq("key", relationshipKey)
      .maybeSingle(),
    normalizedTrade
      ? supabase
          .from("directory_trades")
          .upsert(
            {
              org_id: orgId,
              name: trade?.trim(),
              normalized_name: normalizedTrade,
              is_active: true,
              metadata: { source: "company_form" },
            },
            { onConflict: "org_id,normalized_name" },
          )
          .select("id")
          .single()
      : Promise.resolve({ data: null, error: null }),
  ])

  return {
    relationship_type_id: relationshipResult.data?.id ?? null,
    trade_id: tradeResult.data?.id ?? null,
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
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
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
      license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes,
      tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at,
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

  return mapCompaniesWithAccounting(supabase, orgId, data ?? [])
}

export async function getCompany(companyId: string, orgId?: string): Promise<Company & { contacts: Contact[] }> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data, error } = await supabase
    .from("companies")
    .select(
      `
      id, org_id, name, company_type, phone, email, website, address,
      license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes,
      tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at,
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

  const accountingLinks = await getCompanyAccountingLinks(supabase, resolvedOrgId, [companyId])
  return {
    ...mapCompany(data, accountingLinks.get(companyId)),
    contacts: Array.from(deduped.values()),
  }
}

export async function getClientCompanyReceivables(
  companyId: string,
  orgId?: string,
): Promise<ClientCompanyReceivablesSummary> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const contacts = await getCompanyContacts(companyId, resolvedOrgId)
  const contactIds = new Set(contacts.map((contact) => contact.id).filter(Boolean))
  if (contactIds.size === 0) {
    return { ...emptyClientCompanyReceivablesSummary }
  }

  const visibleProjects = (await listProjects(resolvedOrgId, { supabase, orgId: resolvedOrgId, userId, productTier })).filter(
    (project) => project.client_id && contactIds.has(project.client_id),
  )

  if (visibleProjects.length === 0) {
    return { ...emptyClientCompanyReceivablesSummary }
  }

  const invoiceResults = await Promise.all(
    visibleProjects.map(async (project) => {
      try {
        const invoices = await listInvoices({ orgId: resolvedOrgId, projectId: project.id })
        return { projectId: project.id, invoices, canViewInvoices: true }
      } catch {
        return { projectId: project.id, invoices: [], canViewInvoices: false }
      }
    }),
  )

  const invoiceResultsByProject = new Map(invoiceResults.map((result) => [result.projectId, result]))
  const projects = visibleProjects.map((project) => {
    const invoiceResult = invoiceResultsByProject.get(project.id)
    const invoices = (invoiceResult?.invoices ?? []).filter((invoice) => invoice.status !== "void")
    const contractValue =
      project.billing_contract?.total_cents ??
      project.total_contract_value_cents ??
      moneyValueToCents(project.total_value)
    const invoiced = invoices.reduce((sum, invoice) => sum + (invoice.total_cents ?? 0), 0)
    const outstanding = invoices.reduce(
      (sum, invoice) =>
        sum +
        (invoice.balance_due_cents ??
          (invoice.status === "paid" ? 0 : (invoice.total_cents ?? 0))),
      0,
    )
    const collected = Math.max(0, invoiced - outstanding)

    return {
      project_id: project.id,
      project_name: project.name,
      contract_value_cents: contractValue,
      invoiced_cents: invoiced,
      collected_cents: collected,
      outstanding_cents: Math.max(0, outstanding),
      invoice_count: invoices.length,
      last_activity: latestIsoValue([
        project.updated_at,
        project.created_at,
        ...invoices.flatMap((invoice) => [invoice.updated_at, invoice.sent_at, invoice.issue_date, invoice.created_at]),
      ]),
    } satisfies ClientCompanyReceivableProject
  })

  projects.sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? ""))

  return {
    contract_value_cents: projects.reduce((sum, project) => sum + project.contract_value_cents, 0),
    invoiced_cents: projects.reduce((sum, project) => sum + project.invoiced_cents, 0),
    collected_cents: projects.reduce((sum, project) => sum + project.collected_cents, 0),
    outstanding_cents: projects.reduce((sum, project) => sum + project.outstanding_cents, 0),
    invoice_count: projects.reduce((sum, project) => sum + project.invoice_count, 0),
    can_view_invoices: invoiceResults.every((result) => result.canViewInvoices),
    projects,
  }
}

export async function getCompaniesVendorFinancialSummary(
  companyIds: string[],
  orgId?: string,
  options?: { trailingDays?: number },
): Promise<Record<string, VendorFinancialSummary>> {
  const ids = Array.from(new Set(companyIds.filter(Boolean)))
  const trailingDays = options?.trailingDays ?? 365
  if (ids.length === 0) return {}

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const since = new Date()
  since.setDate(since.getDate() - trailingDays)
  const sinceIso = since.toISOString()
  const result = Object.fromEntries(
    ids.map((id) => [id, emptyVendorFinancialSummary(trailingDays)]),
  ) as Record<string, VendorFinancialSummary>

  let canViewCommitments = false
  try {
    await requireAuthorization({
      permission: "commitment.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      resourceType: "directory",
      resourceId: "vendor_financial_summary",
    })
    canViewCommitments = true
  } catch {
    canViewCommitments = false
  }

  let canViewBills = false
  try {
    await requireAuthorization({
      permission: "bill.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      resourceType: "directory",
      resourceId: "vendor_financial_summary",
    })
    canViewBills = true
  } catch {
    canViewBills = false
  }

  if (canViewCommitments) {
    const { data, error } = await supabase
      .from("commitments")
      .select("id, company_id, total_cents")
      .eq("org_id", resolvedOrgId)
      .in("company_id", ids)
      .gte("created_at", sinceIso)
      .neq("status", "canceled")

    if (error) {
      throw new Error(`Failed to summarize vendor commitments: ${error.message}`)
    }

    for (const row of data ?? []) {
      const companyId = row.company_id as string | null
      if (!companyId || !result[companyId]) continue
      result[companyId].committed_cents += row.total_cents ?? 0
      result[companyId].commitment_count += 1
      result[companyId].can_view_commitments = true
    }
  }

  if (canViewBills) {
    const { data, error } = await supabase
      .from("vendor_bills")
      .select("id, company_id, total_cents, paid_cents, status")
      .eq("org_id", resolvedOrgId)
      .in("company_id", ids)
      .gte("created_at", sinceIso)

    if (error) {
      throw new Error(`Failed to summarize vendor bills: ${error.message}`)
    }

    for (const row of data ?? []) {
      const companyId = row.company_id as string | null
      if (!companyId || !result[companyId]) continue
      result[companyId].billed_cents += row.total_cents ?? 0
      result[companyId].paid_cents +=
        row.paid_cents ?? (row.status === "paid" ? (row.total_cents ?? 0) : 0)
      result[companyId].bill_count += 1
      result[companyId].can_view_bills = true
    }
  }

  return result
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
    prequalified: input.prequalified ?? false,
    prequalified_at: input.prequalified_at ?? null,
    rating: input.rating ?? null,
    default_payment_terms: input.default_payment_terms ?? null,
    internal_notes: input.internal_notes ?? null,
    notes: input.notes ?? null,
    tax_id_last4: input.tax_id_last4 ?? null,
    tax_entity_type: input.tax_entity_type ?? null,
    is_1099_eligible: input.is_1099_eligible ?? null,
    metadata: {
      trade: input.trade,
      license_number: input.license_number,
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
  await requireAnyPermission(["org.member", "directory.write"], { supabase, orgId: resolvedOrgId, userId })
  const classification = await resolveDirectoryCompanyClassification(
    supabase,
    resolvedOrgId,
    parsed.company_type,
    parsed.trade,
  )

  const { data, error } = await supabase
    .from("companies")
    .insert({ ...buildCompanyInsert(parsed, resolvedOrgId), ...classification })
    .select(
      "id, org_id, name, company_type, phone, email, website, address, license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at, metadata, created_at, updated_at, contact_company_links(count)",
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
          requires_additional_insured: d.requires_additional_insured ?? false,
          requires_primary_noncontributory: d.requires_primary_noncontributory ?? false,
          requires_waiver_of_subrogation: d.requires_waiver_of_subrogation ?? false,
          notes: d.notes,
        })),
        orgId: resolvedOrgId,
      }).catch(() => {
        // Best-effort: company creation should succeed even if defaults fail.
      })
    }
  }

  if (parsed.qbo_vendor_id) {
    await saveCompanyAccountingVendorLink({
      supabase,
      orgId: resolvedOrgId,
      companyId: data.id as string,
      externalId: parsed.qbo_vendor_id,
      displayName: parsed.qbo_vendor_name ?? data.name,
      status: parsed.qbo_vendor_sync_status === "error" ? "error" : parsed.qbo_vendor_sync_status === "needs_review" ? "needs_review" : "synced",
    })
  }
  const mapped = await mapCompaniesWithAccounting(supabase, resolvedOrgId, [data])
  return mapped[0]
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
  await requireAnyPermission(["org.member", "directory.write"], { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("companies")
    .select("id, org_id, name, company_type, phone, email, website, address, license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at, metadata, created_at, updated_at")
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

  const nextCompanyType = parsed.company_type ?? existing.company_type
  const nextTrade = parsed.trade ?? existing.metadata?.trade
  const classification = await resolveDirectoryCompanyClassification(
    supabase,
    resolvedOrgId,
    nextCompanyType,
    nextTrade,
  )

  const { data, error } = await supabase
    .from("companies")
    .update({
      name: parsed.name ?? existing.name,
      company_type: nextCompanyType,
      relationship_type_id: classification.relationship_type_id,
      trade_id: classification.trade_id,
      phone: parsed.phone ?? existing.phone,
      email: parsed.email ?? existing.email,
      website: parsed.website ?? existing.website,
      address: parsed.address ?? existing.address,
      license_number: parsed.license_number ?? existing.license_number,
      prequalified: typeof parsed.prequalified === "boolean" ? parsed.prequalified : existing.prequalified,
      prequalified_at: parsed.prequalified_at ?? existing.prequalified_at,
      rating: parsed.rating ?? existing.rating,
      default_payment_terms: parsed.default_payment_terms ?? existing.default_payment_terms,
      internal_notes: parsed.internal_notes ?? existing.internal_notes,
      notes: parsed.notes ?? existing.notes,
      tax_id_last4: parsed.tax_id_last4 ?? existing.tax_id_last4,
      tax_entity_type: parsed.tax_entity_type ?? existing.tax_entity_type,
      is_1099_eligible: typeof parsed.is_1099_eligible === "boolean" ? parsed.is_1099_eligible : existing.is_1099_eligible,
      metadata,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select(
      "id, org_id, name, company_type, phone, email, website, address, license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes, tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at, metadata, created_at, updated_at, contact_company_links(count)",
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

  if (parsed.qbo_vendor_id) {
    await saveCompanyAccountingVendorLink({
      supabase,
      orgId: resolvedOrgId,
      companyId,
      externalId: parsed.qbo_vendor_id,
      displayName: parsed.qbo_vendor_name ?? data.name,
      status: parsed.qbo_vendor_sync_status === "error" ? "error" : parsed.qbo_vendor_sync_status === "needs_review" ? "needs_review" : "synced",
    })
  }
  const mapped = await mapCompaniesWithAccounting(supabase, resolvedOrgId, [data])
  return mapped[0]
}

export async function archiveCompany(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

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

export async function restoreCompany(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const { data: existing, error: fetchError } = await supabase
    .from("companies")
    .select("id, org_id, name, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Company not found")
  }

  const metadata = { ...(existing.metadata ?? {}) }
  delete metadata.archived_at

  const { data, error } = await supabase
    .from("companies")
    .update({ metadata })
    .eq("org_id", resolvedOrgId)
    .eq("id", companyId)
    .select("id, org_id, name, metadata")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to restore company: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "company",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  return true
}

export async function getCompanyContacts(companyId: string, orgId?: string): Promise<Contact[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })
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
