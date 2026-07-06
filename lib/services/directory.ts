import type { SupabaseClient } from "@supabase/supabase-js";

import type { Company, Contact, ContactCompanyLink } from "@/lib/types";
import { requireOrgContext } from "@/lib/services/context";
import { requireAnyPermission } from "@/lib/services/permissions";

export type DirectoryView = "all" | "companies" | "people";
export type DirectorySortKey = "name" | "type" | "detail";
export type DirectorySortDirection = "asc" | "desc";
export type DirectoryEntry =
  | { type: "company"; id: string; name: string; company: Company }
  | { type: "contact"; id: string; name: string; contact: Contact };

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
  entries: DirectoryEntry[];
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

  const trade = row.directory_trades?.name ?? metadata.trade ?? undefined;

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    company_type: row.company_type ?? "other",
    trade,
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
  const trade = row.directory_trades?.name ?? metadata.trade ?? undefined;

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    company_type: row.company_type ?? "other",
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    address: row.address ?? undefined,
    trade,
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
  return { column: "name", ascending };
}

function sortConfigForContacts(
  sort: DirectorySortKey,
  direction: DirectorySortDirection,
) {
  const ascending = direction === "asc";
  if (sort === "type") return { column: "contact_type", ascending };
  if (sort === "detail") return { column: "role", ascending };
  return { column: "full_name", ascending };
}

function chunkArray<T>(values: T[], size = 500) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizedSearch(value?: string) {
  return value?.replaceAll(",", " ").trim() || "";
}

function mapCompaniesToEntries(companies: Company[]): DirectoryEntry[] {
  return companies.map((company) => ({
    type: "company" as const,
    id: company.id,
    name: company.name,
    company,
  }));
}

function mapContactsToEntries(contacts: Contact[]): DirectoryEntry[] {
  return contacts.map((contact) => ({
    type: "contact" as const,
    id: contact.id,
    name: contact.full_name,
    contact,
  }));
}

function directorySortValue(entry: DirectoryEntry, sort: DirectorySortKey) {
  if (sort === "type") {
    return entry.type === "company"
      ? entry.company.company_type
      : entry.contact.contact_type;
  }
  if (sort === "detail") {
    return entry.type === "company"
      ? entry.company.trade || entry.company.company_type
      : entry.contact.role || entry.contact.primary_company?.name || "";
  }
  return entry.name;
}

function compareDirectoryEntries(
  a: DirectoryEntry,
  b: DirectoryEntry,
  sort: DirectorySortKey,
  direction: DirectorySortDirection,
) {
  const multiplier = direction === "desc" ? -1 : 1;
  const primary = directorySortValue(a, sort).localeCompare(
    directorySortValue(b, sort),
    undefined,
    { sensitivity: "base", numeric: true },
  );
  if (primary !== 0) return primary * multiplier;

  const byName = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  if (byName !== 0) return byName * multiplier;
  return a.type.localeCompare(b.type) * multiplier;
}

function entryRows(entries: DirectoryEntry[]) {
  return {
    companies: entries
      .filter(
        (entry): entry is Extract<DirectoryEntry, { type: "company" }> =>
          entry.type === "company",
      )
      .map((entry) => entry.company),
    contacts: entries
      .filter(
        (entry): entry is Extract<DirectoryEntry, { type: "contact" }> =>
          entry.type === "contact",
      )
      .map((entry) => entry.contact),
  };
}

function inputForCompanyQuery(input: DirectoryPageInput) {
  if (input.view !== "all" || !input.type || input.type === "all") return input;
  if (input.type === "vendor") return { ...input, type: "supplier" };
  if (input.type === "internal" || input.type === "consultant") return null;
  return input;
}

function inputForContactQuery(input: DirectoryPageInput) {
  if (input.view !== "all" || !input.type || input.type === "all") return input;
  if (input.type === "supplier") return { ...input, type: "vendor" };
  if (
    input.type === "architect" ||
    input.type === "engineer" ||
    input.type === "other"
  ) {
    return null;
  }
  return input;
}

async function contactIdsForCompanyIds(
  supabase: SupabaseClient,
  orgId: string,
  companyIds: string[],
) {
  const ids = Array.from(new Set(companyIds.filter(Boolean)));
  if (ids.length === 0) return [];

  const contactIds = new Set<string>();
  for (const chunk of chunkArray(ids)) {
    const [
      { data: links, error: linkError },
      { data: primaries, error: primaryError },
    ] = await Promise.all([
      supabase
        .from("contact_company_links")
        .select("contact_id")
        .eq("org_id", orgId)
        .in("company_id", chunk),
      supabase
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .in("primary_company_id", chunk),
    ]);

    if (linkError || primaryError) {
      throw new Error(
        `Failed to resolve contacts for companies: ${linkError?.message ?? primaryError?.message}`,
      );
    }

    for (const row of links ?? []) {
      if ((row as any).contact_id) contactIds.add((row as any).contact_id);
    }
    for (const row of primaries ?? []) {
      if ((row as any).id) contactIds.add((row as any).id);
    }
  }

  return Array.from(contactIds);
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

  return contactIdsForCompanyIds(supabase, orgId, companyIds);
}

async function contactIdsForCompanySearch(
  supabase: SupabaseClient,
  orgId: string,
  search: string,
) {
  if (!search) return [];
  const { data: companies, error } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null)
    .or(`name.ilike.%${search}%,metadata->>trade.ilike.%${search}%`)
    .limit(1000);

  if (error) {
    throw new Error(`Failed to search contact companies: ${error.message}`);
  }

  return contactIdsForCompanyIds(
    supabase,
    orgId,
    (companies ?? []).map((company) => company.id),
  );
}

function applyCompanyFilters(query: any, input: DirectoryPageInput) {
  let next = query;
  if (input.type && input.type !== "all")
    next = next.eq("company_type", input.type);
  if (input.trade && input.trade !== "all")
    next = next.eq("metadata->>trade", input.trade);
  if (input.search) {
    const search = normalizedSearch(input.search);
    next = next.or(
      `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,website.ilike.%${search}%,metadata->>trade.ilike.%${search}%`,
    );
  }
  return next;
}

function applyContactFilters(
  query: any,
  input: DirectoryPageInput,
  searchCompanyContactIds: string[] = [],
) {
  let next = query;
  if (input.type && input.type !== "all")
    next = next.eq("contact_type", input.type);
  if (input.search) {
    const search = normalizedSearch(input.search);
    const clauses = [
      `full_name.ilike.%${search}%`,
      `email.ilike.%${search}%`,
      `phone.ilike.%${search}%`,
      `role.ilike.%${search}%`,
    ];
    if (searchCompanyContactIds.length > 0) {
      clauses.push(`id.in.(${searchCompanyContactIds.join(",")})`);
    }
    next = next.or(clauses.join(","));
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
      directory_trades(name),
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
      primary_company:companies!contacts_primary_company_id_fkey(id, org_id, name, company_type, phone, email, website, address, qbo_vendor_id, qbo_vendor_name, qbo_vendor_synced_at, qbo_vendor_sync_status, metadata, directory_trades(name)),
      contact_company_links(id, org_id, contact_id, company_id, relationship, created_at)
    `,
      { count: "exact" },
    )
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null);

  const searchCompanyContactIds = input.search
    ? await contactIdsForCompanySearch(
        supabase,
        orgId,
        normalizedSearch(input.search),
      )
    : [];

  query = applyContactFilters(query, input, searchCompanyContactIds);
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
      entries: mapCompaniesToEntries(result.rows),
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
      entries: mapContactsToEntries(result.rows),
      total: result.total,
      page,
      pageSize,
    };
  }

  const companyInput = inputForCompanyQuery(input);
  const contactInput = inputForContactQuery(input);
  const fetchLimit = offset + pageSize;
  const [companiesResult, contactsResult] = await Promise.all([
    companyInput
      ? listCompanyPage(supabase, orgId, companyInput, 0, fetchLimit)
      : Promise.resolve({ rows: [] as Company[], total: 0 }),
    contactInput
      ? listContactPage(supabase, orgId, contactInput, 0, fetchLimit)
      : Promise.resolve({ rows: [] as Contact[], total: 0 }),
  ]);
  const total = companiesResult.total + contactsResult.total;
  const entries = [
    ...mapCompaniesToEntries(companiesResult.rows),
    ...mapContactsToEntries(contactsResult.rows),
  ]
    .sort((a, b) =>
      compareDirectoryEntries(
        a,
        b,
        input.sort ?? "name",
        input.direction ?? "asc",
      ),
    )
    .slice(offset, offset + pageSize);
  const rows = entryRows(entries);

  return {
    companies: rows.companies,
    contacts: rows.contacts,
    entries,
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

  const { data: normalizedTrades, error: normalizedError } = await supabase
    .from("directory_trades")
    .select("name")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (!normalizedError && normalizedTrades && normalizedTrades.length > 0) {
    return (normalizedTrades as Array<{ name?: string | null }>)
      .map((row) => row.name)
      .filter(Boolean) as string[];
  }

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
