import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  PartyKind,
  RelationshipType,
  RoleCategory,
  RoleStatus,
} from "@/lib/directory/roles"
import { DIRECTORY_READ_PERMISSIONS as READ_PERMISSIONS } from "@/lib/directory/permissions"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { listRelationshipTypesWithClient } from "@/lib/services/party-roles"

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

export async function listDirectoryPage(input: DirectoryPageInput): Promise<DirectoryPageResult> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const [result, relationshipTypes] = await Promise.all([
    listDirectoryPageWithClient(supabase, orgId, input),
    listRelationshipTypesWithClient(supabase, orgId),
  ])

  return { ...result, relationshipTypes }
}

export async function listDirectoryTrades(): Promise<string[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

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
 * Companies the compliance banner watches: vendor-role, unarchived, capped.
 *
 * The list page used to load EVERY subcontractor and EVERY supplier unpaginated
 * just to feed that banner. This asks the same question against the same
 * paginated view, and the cap is surfaced so a truncated banner never reads as
 * an all-clear.
 */
export async function listComplianceWatchCompanies(limit = 200): Promise<{
  companies: Array<{ id: string; name: string }>
  total: number
  truncated: boolean
}> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId, userId })

  const { data, error, count } = await supabase
    .from("directory_entries")
    .select("id, name", { count: "exact" })
    .eq("org_id", orgId)
    .eq("kind", "company")
    .is("archived_at", null)
    .overlaps("role_categories", ["vendor"])
    .order("sort_name", { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Failed to load compliance watch list: ${error.message}`)
  const companies = (data ?? []).map((row) => {
    const typed = row as { id: string; name: string }
    return { id: typed.id, name: typed.name }
  })
  const total = count ?? companies.length
  return { companies, total, truncated: total > companies.length }
}
