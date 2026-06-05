import type { SupabaseClient } from "@supabase/supabase-js";

import type { Company, Contact, ContactCompanyLink } from "@/lib/types";
import { requireOrgContext } from "@/lib/services/context";
import { requireAnyPermission } from "@/lib/services/permissions";

export type DirectoryView = "all" | "companies" | "people";
export type DirectorySortKey = "name" | "type" | "detail" | "contact";
export type DirectorySortDirection = "asc" | "desc";

export interface DirectoryPageInput {
  view: DirectoryView;
  page: number;
  pageSize: number;
  search?: string;
  type?: string;
  trade?: string;
  sort?: DirectorySortKey;
  direction?: DirectorySortDirection;
}

export interface DirectoryPageResult {
  companies: Company[];
  contacts: Contact[];
  total: number;
  page: number;
  pageSize: number;
}

function mapCompany(row: any): Company {
  const metadata = row?.metadata ?? {};
  const contactCount =
    Array.isArray(row?.contact_company_links) &&
    row.contact_company_links[0]?.count != null
      ? row.contact_company_links[0].count
      : undefined;

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
    prequalified_at:
      row.prequalified_at ?? metadata.prequalified_at ?? undefined,
    rating: row.rating ?? metadata.rating ?? undefined,
    default_payment_terms:
      row.default_payment_terms ?? metadata.default_payment_terms ?? undefined,
    internal_notes: row.internal_notes ?? metadata.internal_notes ?? undefined,
    notes: row.notes ?? metadata.notes ?? undefined,
    qbo_vendor_id: row.qbo_vendor_id ?? metadata.qbo_vendor_id ?? undefined,
    qbo_vendor_name: row.qbo_vendor_name ?? metadata.qbo_vendor_name ?? undefined,
    qbo_vendor_synced_at:
      row.qbo_vendor_synced_at ?? metadata.qbo_vendor_synced_at ?? undefined,
    qbo_vendor_sync_status:
      row.qbo_vendor_sync_status ?? metadata.qbo_vendor_sync_status ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    contact_count: contactCount,
  };
}

function mapContactCompany(row: any): Company {
  const metadata = row?.metadata ?? {};
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
    qbo_vendor_id: row.qbo_vendor_id ?? metadata.qbo_vendor_id ?? undefined,
    qbo_vendor_name: row.qbo_vendor_name ?? metadata.qbo_vendor_name ?? undefined,
    qbo_vendor_synced_at:
      row.qbo_vendor_synced_at ?? metadata.qbo_vendor_synced_at ?? undefined,
    qbo_vendor_sync_status:
      row.qbo_vendor_sync_status ?? metadata.qbo_vendor_sync_status ?? undefined,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? undefined,
  };
}

function mapContact(row: any): Contact {
  const metadata = row?.metadata ?? {};
  const companies: ContactCompanyLink[] =
    row.contact_company_links?.map((link: any) => ({
      id: link.id,
      org_id: link.org_id ?? row.org_id,
      contact_id: link.contact_id ?? row.id,
      company_id: link.company_id,
      relationship: link.relationship ?? undefined,
      created_at: link.created_at ?? row.created_at,
    })) ?? [];

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
    primary_company: row.primary_company
      ? mapContactCompany(row.primary_company)
      : undefined,
    has_portal_access: metadata.has_portal_access ?? false,
    preferred_contact_method: metadata.preferred_contact_method ?? undefined,
    notes: metadata.notes ?? undefined,
    external_crm_id: row.external_crm_id ?? undefined,
    crm_source: row.crm_source ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    companies,
  };
}

function sortConfigForCompanies(
  sort: DirectorySortKey,
  direction: DirectorySortDirection,
) {
  const ascending = direction === "asc";
  if (sort === "type") return { column: "company_type", ascending };
  if (sort === "detail") return { column: "metadata->>trade", ascending };
  if (sort === "contact") return { column: "email", ascending };
  return { column: "name", ascending };
}

function sortConfigForContacts(
  sort: DirectorySortKey,
  direction: DirectorySortDirection,
) {
  const ascending = direction === "asc";
  if (sort === "type") return { column: "contact_type", ascending };
  if (sort === "detail") return { column: "role", ascending };
  if (sort === "contact") return { column: "email", ascending };
  return { column: "full_name", ascending };
}

async function contactIdsForTrade(
  supabase: SupabaseClient,
  orgId: string,
  trade: string,
) {
  const { data: companies, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .eq("metadata->>trade", trade)
    .is("metadata->>archived_at", null);

  if (companyError)
    throw new Error(
      `Failed to filter contacts by trade: ${companyError.message}`,
    );

  const companyIds = (companies ?? []).map((company) => company.id);
  if (companyIds.length === 0) return [];

  const [
    { data: links, error: linkError },
    { data: primaries, error: primaryError },
  ] = await Promise.all([
    supabase
      .from("contact_company_links")
      .select("contact_id")
      .eq("org_id", orgId)
      .in("company_id", companyIds),
    supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .in("primary_company_id", companyIds),
  ]);

  if (linkError || primaryError)
    throw new Error(
      `Failed to filter contacts by trade: ${linkError?.message ?? primaryError?.message}`,
    );

  return Array.from(
    new Set(
      [
        ...(links ?? []).map((row: any) => row.contact_id),
        ...(primaries ?? []).map((row: any) => row.id),
      ].filter(Boolean),
    ),
  );
}

function applyCompanyFilters(query: any, input: DirectoryPageInput) {
  let next = query;
  if (input.type && input.type !== "all")
    next = next.eq("company_type", input.type);
  if (input.trade && input.trade !== "all")
    next = next.eq("metadata->>trade", input.trade);
  if (input.search) {
    const search = input.search.replaceAll(",", " ");
    next = next.or(
      `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,website.ilike.%${search}%`,
    );
  }
  return next;
}

function applyContactFilters(query: any, input: DirectoryPageInput) {
  let next = query;
  if (input.type && input.type !== "all")
    next = next.eq("contact_type", input.type);
  if (input.search) {
    const search = input.search.replaceAll(",", " ");
    next = next.or(
      `full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,role.ilike.%${search}%`,
    );
  }
  return next;
}

async function listCompanyPage(
  supabase: SupabaseClient,
  orgId: string,
  input: DirectoryPageInput,
  offset: number,
  limit: number,
) {
  const sort = sortConfigForCompanies(
    input.sort ?? "name",
    input.direction ?? "asc",
  );
  let query = supabase
    .from("companies")
    .select(
      `
      id, org_id, name, company_type, phone, email, website, address,
      license_number, prequalified, prequalified_at, rating, default_payment_terms, internal_notes, notes,
      qbo_vendor_id, qbo_vendor_name, qbo_vendor_synced_at, qbo_vendor_sync_status,
      metadata, created_at, updated_at,
      contact_company_links(count)
    `,
      { count: "exact" },
    )
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null);

  query = applyCompanyFilters(query, input);

  const { data, error, count } = await query
    .order(sort.column, { ascending: sort.ascending })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Failed to list companies: ${error.message}`);
  return { rows: (data ?? []).map(mapCompany), total: count ?? 0 };
}

async function listContactPage(
  supabase: SupabaseClient,
  orgId: string,
  input: DirectoryPageInput,
  offset: number,
  limit: number,
) {
  const sort = sortConfigForContacts(
    input.sort ?? "name",
    input.direction ?? "asc",
  );
  const tradeContactIds =
    input.trade && input.trade !== "all"
      ? await contactIdsForTrade(supabase, orgId, input.trade)
      : undefined;
  if (tradeContactIds && tradeContactIds.length === 0) {
    return { rows: [], total: 0 };
  }

  let query = supabase
    .from("contacts")
    .select(
      `
      id, org_id, full_name, email, phone, address, role, contact_type, primary_company_id, external_crm_id, crm_source, metadata, created_at, updated_at,
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, qbo_vendor_id, qbo_vendor_name, qbo_vendor_synced_at, qbo_vendor_sync_status, metadata),
      contact_company_links(id, org_id, contact_id, company_id, relationship, created_at)
    `,
      { count: "exact" },
    )
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null);

  query = applyContactFilters(query, input);
  if (tradeContactIds) query = query.in("id", tradeContactIds);
  const { data, error, count } = await query
    .order(sort.column, { ascending: sort.ascending })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Failed to list contacts: ${error.message}`);
  return { rows: (data ?? []).map(mapContact), total: count ?? 0 };
}

export async function listDirectoryPage(
  input: DirectoryPageInput,
): Promise<DirectoryPageResult> {
  const { supabase, orgId, userId } = await requireOrgContext();
  await requireAnyPermission(
    ["org.member", "org.read", "directory.read", "directory.write"],
    { supabase, orgId, userId },
  );

  const page = Math.max(1, input.page);
  const pageSize = Math.max(1, Math.min(100, input.pageSize));
  const offset = (page - 1) * pageSize;

  if (input.view === "companies") {
    const result = await listCompanyPage(
      supabase,
      orgId,
      input,
      offset,
      pageSize,
    );
    return {
      companies: result.rows,
      contacts: [],
      total: result.total,
      page,
      pageSize,
    };
  }

  if (input.view === "people") {
    const result = await listContactPage(
      supabase,
      orgId,
      input,
      offset,
      pageSize,
    );
    return {
      companies: [],
      contacts: result.rows,
      total: result.total,
      page,
      pageSize,
    };
  }

  const companyBase = await listCompanyPage(supabase, orgId, input, 0, 1);
  const contactBase = await listContactPage(supabase, orgId, input, 0, 1);
  const total = companyBase.total + contactBase.total;

  if (offset < companyBase.total) {
    const companiesResult = await listCompanyPage(
      supabase,
      orgId,
      input,
      offset,
      pageSize,
    );
    const remaining = pageSize - companiesResult.rows.length;
    const contactsResult =
      remaining > 0
        ? await listContactPage(supabase, orgId, input, 0, remaining)
        : { rows: [] as Contact[], total: contactBase.total };
    return {
      companies: companiesResult.rows,
      contacts: contactsResult.rows,
      total,
      page,
      pageSize,
    };
  }

  const contactOffset = offset - companyBase.total;
  const contactsResult = await listContactPage(
    supabase,
    orgId,
    input,
    contactOffset,
    pageSize,
  );
  return {
    companies: [],
    contacts: contactsResult.rows,
    total,
    page,
    pageSize,
  };
}

export async function listDirectoryTrades(): Promise<string[]> {
  const { supabase, orgId, userId } = await requireOrgContext();
  await requireAnyPermission(
    ["org.member", "org.read", "directory.read", "directory.write"],
    { supabase, orgId, userId },
  );
  const { data, error } = await supabase
    .from("companies")
    .select("metadata")
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null);

  if (error)
    throw new Error(`Failed to list directory trades: ${error.message}`);
  return Array.from(
    new Set(
      (data ?? []).map((row: any) => row.metadata?.trade).filter(Boolean),
    ),
  ).sort();
}
