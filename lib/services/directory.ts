import type { SupabaseClient } from "@supabase/supabase-js"
import { cacheLife, cacheTag } from "next/cache"

import type {
  PartyKind,
  RelationshipType,
  RoleCategory,
  RoleStatus,
} from "@/lib/directory/roles"
import { DIRECTORY_READ_PERMISSIONS as READ_PERMISSIONS } from "@/lib/directory/permissions"
import { requireOrgContext } from "@/lib/services/context"
import type { OrgServiceContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { listRelationshipTypesWithClient } from "@/lib/services/party-roles"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type DirectorySortKey = "name" | "detail" | "recent"
export type DirectorySortDirection = "asc" | "desc"

/**
 * A role as a list row shows it. Deliberately not the full `PartyRole` — the
 * list needs a label and a lifecycle state, and loading role ids for 25 rows to
 * render chips nobody clicks would be a query per page for nothing.
 */
export interface DirectoryRoleState {
  key: string
  label: string
  status: RoleStatus
}

/**
 * One row of the directory, company or person.
 *
 * This used to be a discriminated union carrying a whole `Company` or `Contact`
 * DTO, and the page was handed the same rows three times over (`companies`,
 * `contacts`, and `entries`). A list row needs what a list row shows; the
 * account page loads the full record.
 */
export interface DirectoryEntry {
  kind: PartyKind
  id: string
  name: string
  email?: string
  phone?: string
  /** Trade for a company, title for a person. */
  detail?: string
  trade?: string
  primary_company_id?: string
  primary_company_name?: string
  role_keys: string[]
  role_categories: RoleCategory[]
  roles: DirectoryRoleState[]
  created_at: string
  updated_at?: string
}

export interface DirectoryPageInput {
  /**
   * Companies or contacts. The only navigation axis the directory has: you are
   * always looking at one kind of party, never a mixed table. Role and trade
   * narrow that list like any other filter.
   */
  kind: PartyKind
  page: number
  pageSize: number
  search?: string
  trade?: string
  role?: string
  sort?: DirectorySortKey
  direction?: DirectorySortDirection
}

export interface DirectoryPageResult {
  entries: DirectoryEntry[]
  total: number
  page: number
  pageSize: number
  /** The org's role vocabulary, so the list can label chips without a second load. */
  relationshipTypes: RelationshipType[]
}

export interface DirectoryInitialPageResult extends DirectoryPageResult {
  trades: string[]
}

export type DirectoryPageWindow = Omit<DirectoryPageResult, "relationshipTypes">

export interface DirectoryInitialPagesResult {
  company: DirectoryPageWindow
  contact: DirectoryPageWindow
  relationshipTypes: RelationshipType[]
  trades: string[]
}

interface DirectoryEntryRow {
  kind: string
  id: string
  name: string
  email: string | null
  phone: string | null
  trade: string | null
  title: string | null
  detail: string | null
  primary_company_id: string | null
  primary_company_name: string | null
  created_at: string
  updated_at: string | null
  role_keys: string[] | null
  role_categories: string[] | null
  role_states: Array<{ key?: string; label?: string; status?: string }> | null
}

function mapRoleStates(value: DirectoryEntryRow["role_states"]): DirectoryRoleState[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((role): role is { key: string; label: string; status: string } =>
      Boolean(role?.key && role?.label && role?.status),
    )
    .map((role) => ({ key: role.key, label: role.label, status: role.status as RoleStatus }))
}

function mapEntry(row: DirectoryEntryRow): DirectoryEntry {
  return {
    kind: row.kind === "company" ? "company" : "contact",
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    detail: row.detail ?? undefined,
    trade: row.trade ?? undefined,
    primary_company_id: row.primary_company_id ?? undefined,
    primary_company_name: row.primary_company_name ?? undefined,
    role_keys: row.role_keys ?? [],
    role_categories: (row.role_categories ?? []) as RoleCategory[],
    roles: mapRoleStates(row.role_states),
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
  }
}

/**
 * PostgREST's `or` filter is a comma-separated grammar with parenthesised
 * groups, so a search term carrying those characters would change the shape of
 * the query rather than being matched by it. Stripping them is enough because
 * every clause built below places the term inside `ilike.%…%`, where the
 * remaining characters — dots in an email, dashes in a phone number — are
 * literal.
 */
function sanitizeSearch(value?: string): string {
  if (!value) return ""
  return value
    .replace(/[,()"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function sortColumn(sort: DirectorySortKey): string {
  if (sort === "detail") return "detail"
  if (sort === "recent") return "created_at"
  return "sort_name"
}

const ENTRY_COLUMNS =
  "kind, id, name, email, phone, trade, title, detail, primary_company_id, primary_company_name, created_at, updated_at, role_keys, role_categories, role_states"

async function listDirectoryPageWithClient(
  supabase: SupabaseClient,
  orgId: string,
  input: DirectoryPageInput,
): Promise<Omit<DirectoryPageResult, "relationshipTypes">> {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, Math.min(100, input.pageSize))
  const offset = (page - 1) * pageSize
  const sort = input.sort ?? "name"
  const ascending = (input.direction ?? "asc") === "asc"

  let query = supabase
    .from("directory_entries")
    .select(ENTRY_COLUMNS, { count: "exact" })
    .eq("org_id", orgId)
    .is("archived_at", null)

  query = query.eq("kind", input.kind)

  if (input.role && input.role !== "all") {
    query = query.overlaps("role_keys", [input.role])
  }

  if (input.trade && input.trade !== "all") {
    query = query.eq("trade", input.trade)
  }

  const search = sanitizeSearch(input.search)
  if (search) {
    query = query.or(
      [
        `name.ilike.%${search}%`,
        `email.ilike.%${search}%`,
        `phone.ilike.%${search}%`,
        `detail.ilike.%${search}%`,
        `primary_company_name.ilike.%${search}%`,
      ].join(","),
    )
  }

  const { data, error, count } = await query
    .order(sortColumn(sort), { ascending })
    .order("id", { ascending: true })
    .range(offset, offset + pageSize - 1)

  if (error) throw new Error(`Failed to list directory: ${error.message}`)

  return {
    entries: ((data ?? []) as DirectoryEntryRow[]).map(mapEntry),
    total: count ?? 0,
    page,
    pageSize,
  }
}

async function listDirectoryTradesWithClient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("directory_trades")
    .select("name")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("name", { ascending: true })

  if (error) throw new Error(`Failed to list directory trades: ${error.message}`)
  return (data ?? [])
    .map((row) => (row as { name: string | null }).name)
    .filter((name): name is string => Boolean(name))
}

/**
 * Org-owned lookup vocabulary changes rarely and contains no user data. The
 * caller still passes the normal directory permission gate before reaching
 * this cache; the service client only makes the cached entry independent of a
 * request-scoped Supabase client. `orgId` is part of the cache key and tag, so
 * data can never cross organizations.
 */
async function getCachedDirectoryVocabulary(orgId: string): Promise<{
  relationshipTypes: RelationshipType[]
  trades: string[]
}> {
  "use cache"
  cacheLife({ stale: 300, revalidate: 900, expire: 3600 })
  cacheTag("directory-vocabulary", `directory-vocabulary:${orgId}`)

  const supabase = createServiceSupabaseClient()
  const [relationshipTypes, trades] = await Promise.all([
    listRelationshipTypesWithClient(supabase, orgId),
    listDirectoryTradesWithClient(supabase, orgId),
  ])
  return { relationshipTypes, trades }
}

export async function listDirectoryPage(input: DirectoryPageInput): Promise<DirectoryPageResult> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const [result, vocabulary] = await Promise.all([
    listDirectoryPageWithClient(supabase, orgId, input),
    getCachedDirectoryVocabulary(orgId),
  ])

  return { ...result, relationshipTypes: vocabulary.relationshipTypes }
}

/**
 * The account header only needs the same compact identity already used by the
 * list. Avoid loading contacts, accounting links and edit-only fields before a
 * destination can show its name and tabs.
 */
export async function getDirectoryEntry(
  entryId: string,
  context?: OrgServiceContext,
): Promise<DirectoryEntry | null> {
  const { supabase, orgId, userId } = context ?? (await requireOrgContext())
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const { data, error } = await supabase
    .from("directory_entries")
    .select(ENTRY_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", entryId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load directory identity: ${error.message}`)
  return data ? mapEntry(data as DirectoryEntryRow) : null
}

/**
 * First-page path used by the RSC. It resolves auth and the directory read gate
 * once, starts the row query and cached vocabulary together, and returns every
 * lookup needed by the toolbar without a second service orchestration pass.
 */
export async function listDirectoryInitialPage(
  input: DirectoryPageInput,
  context?: OrgServiceContext,
): Promise<DirectoryInitialPageResult> {
  const { supabase, orgId, userId } = context ?? (await requireOrgContext())
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const [result, vocabulary] = await Promise.all([
    listDirectoryPageWithClient(supabase, orgId, input),
    getCachedDirectoryVocabulary(orgId),
  ])

  return {
    ...result,
    relationshipTypes: vocabulary.relationshipTypes,
    trades: vocabulary.trades,
  }
}

/**
 * Load both kind tabs behind one context and permission check. The two row
 * queries run together, so the inactive tab costs one cheap database query on
 * the initial request instead of a complete authenticated RSC navigation when
 * somebody switches tabs.
 */
export async function listDirectoryInitialPages(
  inputs: Record<PartyKind, DirectoryPageInput>,
  context?: OrgServiceContext,
): Promise<DirectoryInitialPagesResult> {
  const { supabase, orgId, userId } = context ?? (await requireOrgContext())
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const [company, contact, vocabulary] = await Promise.all([
    listDirectoryPageWithClient(supabase, orgId, inputs.company),
    listDirectoryPageWithClient(supabase, orgId, inputs.contact),
    getCachedDirectoryVocabulary(orgId),
  ])

  return {
    company,
    contact,
    relationshipTypes: vocabulary.relationshipTypes,
    trades: vocabulary.trades,
  }
}

export async function listDirectoryTrades(): Promise<string[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  return (await getCachedDirectoryVocabulary(orgId)).trades
}

/**
 * Companies the compliance banner watches: explicitly enrolled, unarchived, capped.
 *
 * The list page used to load EVERY subcontractor and EVERY supplier unpaginated
 * just to feed that banner. This asks the same question against the same
 * list, and the cap is surfaced so a truncated banner never reads as an
 * all-clear. A vendor role alone is intentionally insufficient: office payees
 * must not create compliance noise.
 */
export async function listComplianceWatchCompanies(
  limit = 200,
  context?: OrgServiceContext,
): Promise<{
  companies: Array<{ id: string; name: string }>
  total: number
  truncated: boolean
}> {
  const { supabase, orgId, userId } = context ?? (await requireOrgContext())
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const { data, error, count } = await supabase
    .from("companies")
    .select("id, name", { count: "exact" })
    .eq("org_id", orgId)
    .eq("compliance_monitoring_enabled", true)
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Failed to load compliance watch list: ${error.message}`)
  const companies = (data ?? []).map((row) => {
    const typed = row as { id: string; name: string }
    return { id: typed.id, name: typed.name }
  })
  const total = count ?? companies.length
  return { companies, total, truncated: total > companies.length }
}

/** Who to write to on behalf of a company, and what that address actually is. */
export interface CompanyRecipient {
  email: string
  name: string | null
  /** Null when the address is the company's own rather than a person's. */
  contactId: string | null
  kind: "company" | "contact"
}

/**
 * The one answer to "who do we email about this vendor".
 *
 * Four callers each had their own version of this — the compliance autopilot,
 * the decision notice, the document request, and the prequalification invite —
 * and every one of them found people by `contacts.primary_company_id`. That
 * column is one of the two disagreeing sources `20260819215644_directory_hygiene`
 * was written to reconcile; `contact_company_links` is the linkage. A contact
 * attached from the company side was therefore invisible to all four, which
 * surfaced to the builder as "No email on file" for a vendor whose contact is
 * sitting right there on the Contacts tab.
 *
 * The company's own address wins when it has one — it is the address the builder
 * chose to record for correspondence — and otherwise the primary linked contact,
 * then the earliest linked contact.
 *
 * Takes a client because the autopilot runs unattended with no org context.
 */
export async function resolveCompanyRecipients(
  supabase: SupabaseClient,
  orgId: string,
  companyIds: string[],
): Promise<Map<string, CompanyRecipient>> {
  const result = new Map<string, CompanyRecipient>()
  const uniqueIds = Array.from(new Set(companyIds.filter(Boolean)))
  if (uniqueIds.length === 0) return result

  const [companiesResult, linksResult] = await Promise.all([
    supabase.from("companies").select("id, name, email").eq("org_id", orgId).in("id", uniqueIds),
    supabase
      .from("contact_company_links")
      .select("company_id, is_primary, created_at, contacts (id, full_name, email)")
      .eq("org_id", orgId)
      .in("company_id", uniqueIds)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true }),
  ])

  for (const company of companiesResult.data ?? []) {
    const email = typeof company.email === "string" ? company.email.trim() : ""
    if (!email) continue
    result.set(String(company.id), {
      email,
      name: company.name ?? null,
      contactId: null,
      kind: "company",
    })
  }

  for (const link of linksResult.data ?? []) {
    const companyId = String(link.company_id)
    if (result.has(companyId)) continue
    const contact = Array.isArray(link.contacts) ? link.contacts[0] : link.contacts
    const email = typeof contact?.email === "string" ? contact.email.trim() : ""
    if (!email) continue
    result.set(companyId, {
      email,
      name: contact?.full_name ?? null,
      contactId: contact?.id ? String(contact.id) : null,
      kind: "contact",
    })
  }

  return result
}

/** One company's recipient, for the callers that only ever ask about one. */
export async function resolveCompanyRecipient(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<CompanyRecipient | null> {
  const map = await resolveCompanyRecipients(supabase, orgId, [companyId])
  return map.get(companyId) ?? null
}
