import type { SupabaseClient } from "@supabase/supabase-js"

import {
  isCurrentRole,
  isStatusValidForCategory,
  resolvePartyCapabilities,
  type PartyCapabilities,
  type PartyKind,
  type PartyRole,
  type RelationshipType,
  type RoleCategory,
  type RoleSource,
  type RoleStatus,
} from "@/lib/directory/roles"
import {
  DIRECTORY_READ_PERMISSIONS as READ_PERMISSIONS,
  DIRECTORY_WRITE_PERMISSIONS as WRITE_PERMISSIONS,
} from "@/lib/directory/permissions"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const ROLE_SELECT = `
  id, org_id, company_id, contact_id, relationship_type_id, status, since, until, source, notes,
  relationship_type:directory_relationship_types!party_roles_relationship_type_id_fkey(
    id, key, label, canonical_category, applies_to, sort_order
  )
`

interface RelationshipTypeRow {
  id: string
  key: string
  label: string
  canonical_category: string
  applies_to: string
  sort_order: number | null
}

interface PartyRoleRow {
  id: string
  org_id: string
  company_id: string | null
  contact_id: string | null
  relationship_type_id: string
  status: string
  since: string
  until: string | null
  source: string
  notes: string | null
  relationship_type: RelationshipTypeRow | RelationshipTypeRow[] | null
}

function firstRelated(value: RelationshipTypeRow | RelationshipTypeRow[] | null): RelationshipTypeRow | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

function mapRelationshipType(row: RelationshipTypeRow): RelationshipType {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    category: row.canonical_category as RoleCategory,
    applies_to: row.applies_to as PartyKind | "both",
    sort_order: row.sort_order ?? 0,
  }
}

function mapPartyRole(row: PartyRoleRow): PartyRole | null {
  const type = firstRelated(row.relationship_type)
  // A role whose taxonomy row is unreadable cannot be interpreted, and guessing
  // a category here would silently grant or withhold account tabs.
  if (!type) return null
  return {
    id: row.id,
    relationship_type_id: row.relationship_type_id,
    key: type.key,
    label: type.label,
    category: type.canonical_category as RoleCategory,
    status: row.status as RoleStatus,
    since: row.since,
    until: row.until ?? undefined,
  }
}

export async function listRelationshipTypesWithClient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<RelationshipType[]> {
  const { data, error } = await supabase
    .from("directory_relationship_types")
    .select("id, key, label, canonical_category, applies_to, sort_order")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true })

  if (error) throw new Error(`Failed to load directory relationship types: ${error.message}`)
  return (data ?? []).map((row) => mapRelationshipType(row as RelationshipTypeRow))
}

export async function listRelationshipTypes(orgId?: string): Promise<RelationshipType[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })
  return listRelationshipTypesWithClient(supabase, resolvedOrgId)
}

/**
 * Roles for many parties at once, keyed by party id. Companies and contacts
 * share the return map because ids are uuids and a caller asking for both — the
 * directory list does — wants one lookup, not two.
 */
export async function getPartyRolesWithClient(
  supabase: SupabaseClient,
  orgId: string,
  input: { companyIds?: string[]; contactIds?: string[] },
): Promise<Map<string, PartyRole[]>> {
  const companyIds = Array.from(new Set((input.companyIds ?? []).filter(Boolean)))
  const contactIds = Array.from(new Set((input.contactIds ?? []).filter(Boolean)))
  const result = new Map<string, PartyRole[]>()
  if (companyIds.length === 0 && contactIds.length === 0) return result

  const [companyResponse, contactResponse] = await Promise.all([
    companyIds.length > 0
      ? supabase.from("party_roles").select(ROLE_SELECT).eq("org_id", orgId).in("company_id", companyIds)
      : null,
    contactIds.length > 0
      ? supabase.from("party_roles").select(ROLE_SELECT).eq("org_id", orgId).in("contact_id", contactIds)
      : null,
  ])

  for (const response of [companyResponse, contactResponse]) {
    if (!response) continue
    if (response.error) throw new Error(`Failed to load party roles: ${response.error.message}`)
    for (const raw of (response.data as unknown as PartyRoleRow[] | null) ?? []) {
      const partyId = raw.company_id ?? raw.contact_id
      if (!partyId) continue
      const role = mapPartyRole(raw)
      if (!role) continue
      const existing = result.get(partyId)
      if (existing) existing.push(role)
      else result.set(partyId, [role])
    }
  }
  return result
}

export async function getPartyRoles(input: {
  companyIds?: string[]
  contactIds?: string[]
  orgId?: string
}): Promise<Map<string, PartyRole[]>> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(input.orgId)
  await requireAnyPermission(READ_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })
  return getPartyRolesWithClient(supabase, resolvedOrgId, input)
}


async function resolveRelationshipType(
  supabase: SupabaseClient,
  orgId: string,
  roleKey: string,
): Promise<RelationshipType> {
  const { data, error } = await supabase
    .from("directory_relationship_types")
    .select("id, key, label, canonical_category, applies_to, sort_order")
    .eq("org_id", orgId)
    .eq("key", roleKey)
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve relationship type: ${error.message}`)
  if (!data) throw new Error(`Unknown directory role "${roleKey}"`)
  return mapRelationshipType(data as RelationshipTypeRow)
}

export interface AssignPartyRoleInput {
  kind: PartyKind
  partyId: string
  roleKey: string
  status?: RoleStatus
  source?: RoleSource
  notes?: string
  orgId?: string
}

export async function assignPartyRole(input: AssignPartyRoleInput): Promise<PartyRole> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(input.orgId)
  await requireAnyPermission(WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })
  return assignPartyRoleWithClient(supabase, resolvedOrgId, userId, input)
}

export async function assignPartyRoleWithClient(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  input: AssignPartyRoleInput,
): Promise<PartyRole> {
  const type = await resolveRelationshipType(supabase, orgId, input.roleKey)
  // Recording someone in the directory says the relationship exists now. The
  // funnel states are set deliberately by the flow that owns them (sales sets
  // inquiry, bidding sets invited), never inferred from a create.
  const status = input.status ?? "active"
  if (!isStatusValidForCategory(status, type.category)) {
    throw new Error(`Status "${status}" does not apply to a ${type.category} role`)
  }

  const partyColumn = input.kind === "company" ? "company_id" : "contact_id"
  const { data, error } = await supabase
    .from("party_roles")
    .upsert(
      {
        org_id: orgId,
        [partyColumn]: input.partyId,
        relationship_type_id: type.id,
        status,
        source: input.source ?? "manual",
        notes: input.notes ?? null,
        // Re-assigning a role that was ended revives it rather than leaving a
        // dead `until` behind that would keep it out of every current-role read.
        until: null,
      },
      {
        onConflict:
          input.kind === "company"
            ? "org_id,company_id,relationship_type_id"
            : "org_id,contact_id,relationship_type_id",
      },
    )
    .select(ROLE_SELECT)
    .single()

  if (error || !data) throw new Error(`Failed to assign role: ${error?.message}`)
  const role = mapPartyRole(data as PartyRoleRow)
  if (!role) throw new Error("Failed to assign role: relationship type could not be read back")

  await recordEvent({
    orgId,
    eventType: "party_role_assigned",
    entityType: input.kind,
    entityId: input.partyId,
    payload: { role_key: type.key, status, source: input.source ?? "manual" },
  })
  await recordAudit({
    orgId,
    actorId: userId ?? undefined,
    action: "insert",
    entityType: "party_role",
    entityId: role.id,
    after: data,
  })

  return role
}

/**
 * Move a role along its lifecycle: a prospect becomes a buyer, an invited
 * vendor becomes active. The transition is the CRM history — it is why a role
 * carries state at all rather than being a bare tag.
 */
export async function updatePartyRoleStatus(input: {
  roleId: string
  status: RoleStatus
  orgId?: string
}): Promise<PartyRole> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(input.orgId)
  await requireAnyPermission(WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("party_roles")
    .select(ROLE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", input.roleId)
    .maybeSingle()

  if (existingError || !existing) throw new Error("Role not found")
  const previous = mapPartyRole(existing as PartyRoleRow)
  if (!previous) throw new Error("Role not found")
  if (!isStatusValidForCategory(input.status, previous.category)) {
    throw new Error(`Status "${input.status}" does not apply to a ${previous.category} role`)
  }

  const { data, error } = await supabase
    .from("party_roles")
    .update({ status: input.status })
    .eq("org_id", resolvedOrgId)
    .eq("id", input.roleId)
    .select(ROLE_SELECT)
    .maybeSingle()

  if (error || !data) throw new Error(`Failed to update role: ${error?.message}`)
  const role = mapPartyRole(data as PartyRoleRow)
  if (!role) throw new Error("Failed to update role")

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "party_role_status_changed",
    entityType: (existing as PartyRoleRow).company_id ? "company" : "contact",
    entityId: ((existing as PartyRoleRow).company_id ?? (existing as PartyRoleRow).contact_id) as string,
    payload: { role_key: role.key, from: previous.status, to: input.status },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId ?? undefined,
    action: "update",
    entityType: "party_role",
    entityId: input.roleId,
    before: existing,
    after: data,
  })

  return role
}

/**
 * End a role without deleting it. A vendor you stopped using and a vendor you
 * never had are different facts, and the bills already posted against the first
 * one still need it to be explicable.
 */
export async function endPartyRole(input: { roleId: string; orgId?: string }): Promise<boolean> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(input.orgId)
  await requireAnyPermission(WRITE_PERMISSIONS, { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("party_roles")
    .select(ROLE_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", input.roleId)
    .maybeSingle()

  if (existingError || !existing) throw new Error("Role not found")

  const { data, error } = await supabase
    .from("party_roles")
    .update({ until: new Date().toISOString(), status: "inactive" })
    .eq("org_id", resolvedOrgId)
    .eq("id", input.roleId)
    .select(ROLE_SELECT)
    .maybeSingle()

  if (error || !data) throw new Error(`Failed to end role: ${error?.message}`)

  const ended = mapPartyRole(data as PartyRoleRow)
  const row = existing as PartyRoleRow
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "party_role_ended",
    entityType: row.company_id ? "company" : "contact",
    entityId: (row.company_id ?? row.contact_id) as string,
    payload: { role_key: ended?.key ?? null },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId ?? undefined,
    action: "update",
    entityType: "party_role",
    entityId: input.roleId,
    before: existing,
    after: data,
  })

  return true
}

/**
 * End every current role on a party, as archiving it does.
 *
 * Archiving used to touch only `archived_at`, so an archived company kept live
 * vendor roles: it vanished from the directory list and the compliance watch
 * list (both filter on `archived_at`) while `resolvePartyCapabilities` still
 * called it a vendor. Anything reading roles rather than the list — a picker, a
 * commitment guard — went on treating it as active.
 *
 * Runs on the caller's client so it joins the archive's transaction context,
 * and is a no-op when nothing is live.
 */
export async function endPartyRolesForPartyWithClient(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  input: { kind: PartyKind; partyId: string; endedAt?: string },
): Promise<number> {
  const roles = await getPartyRolesWithClient(supabase, orgId, {
    companyIds: input.kind === "company" ? [input.partyId] : [],
    contactIds: input.kind === "contact" ? [input.partyId] : [],
  })
  const live = (roles.get(input.partyId) ?? []).filter((role) => isCurrentRole(role))
  if (live.length === 0) return 0

  // Stamped with the archive's own timestamp so `revivePartyRolesEndedAt` can
  // tell the roles archiving ended from ones ended deliberately beforehand.
  const endedAt = input.endedAt ?? new Date().toISOString()
  const { data, error } = await supabase
    .from("party_roles")
    .update({ until: endedAt, status: "inactive" })
    .eq("org_id", orgId)
    .in(
      "id",
      live.map((role) => role.id),
    )
    .select("id")

  if (error) throw new Error(`Failed to end roles: ${error.message}`)

  await recordAudit({
    orgId,
    actorId: userId ?? undefined,
    action: "update",
    entityType: "party_role",
    entityId: input.partyId,
    before: { roles: live },
    after: { ended_at: endedAt, role_ids: (data ?? []).map((row) => row.id) },
  })

  return data?.length ?? live.length
}

/**
 * Revive the roles an archive ended, and only those.
 *
 * Restoring a party has to give back what archiving took, or the record comes
 * back roleless — invisible to every lens, which is exactly the state the
 * directory backfill exists to repair. Matching on the archive timestamp leaves
 * roles that were ended deliberately before the archive ended.
 */
export async function revivePartyRolesEndedAtWithClient(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  input: { kind: PartyKind; partyId: string; endedAt: string },
): Promise<number> {
  const partyColumn = input.kind === "company" ? "company_id" : "contact_id"
  const { data, error } = await supabase
    .from("party_roles")
    .update({ until: null, status: "active" })
    .eq("org_id", orgId)
    .eq(partyColumn, input.partyId)
    .eq("until", input.endedAt)
    .select("id")

  if (error) throw new Error(`Failed to restore roles: ${error.message}`)
  if (!data || data.length === 0) return 0

  await recordAudit({
    orgId,
    actorId: userId ?? undefined,
    action: "update",
    entityType: "party_role",
    entityId: input.partyId,
    before: { ended_at: input.endedAt },
    after: { restored_role_ids: data.map((row) => row.id) },
  })

  return data.length
}

/**
 * What a company is on a project roster, decided by its roles.
 *
 * `project_vendors.role` used to be copied from `companies.company_type`. That
 * column is no longer the source of truth — a company can become a vendor
 * through `ensureVendorRoleWithClient` without it ever being touched — so the
 * roster and the directory disagreed about the same company.
 *
 * The roster's vocabulary is narrower than the role catalog: it wants the one
 * word that describes how this company shows up on a job. Anything on the AP
 * rail that is not specifically a supplier is a subcontractor, which is the same
 * default the type-column version fell back to.
 */
const ROSTER_ROLE_KEYS = ["supplier", "architect", "engineer", "client"] as const

export async function resolveProjectVendorRole(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<string> {
  const roleMap = await getPartyRolesWithClient(supabase, orgId, { companyIds: [companyId] })
  const roles = (roleMap.get(companyId) ?? []).filter((role) => isCurrentRole(role))
  const match = ROSTER_ROLE_KEYS.find((key) => roles.some((role) => role.key === key))
  return match ?? "subcontractor"
}

/**
 * Guarantee the vendor role on a company this org is about to owe money to.
 *
 * `resolveCompanyPosture` used to infer "vendor" at read time from the absence
 * of architect/engineer, precisely because a company could acquire commitments
 * without ever being typed as a vendor. Recording it at the moment the
 * commitment is made is what lets the read path be pure role math — and it is
 * the same rule `ensureProjectVendorForCommitment` already applied by treating
 * an unrecognized type as a subcontractor.
 */
export async function ensureVendorRoleWithClient(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
  userId: string | null,
): Promise<void> {
  const roles = await getPartyRolesWithClient(supabase, orgId, { companyIds: [companyId] })
  const existing = roles.get(companyId) ?? []
  if (resolvePartyCapabilities(existing).isVendor) return

  await assignPartyRoleWithClient(supabase, orgId, userId, {
    kind: "company",
    partyId: companyId,
    roleKey: "subcontractor",
    status: "active",
    source: "system",
  })
}
