import type { SupabaseClient } from "@supabase/supabase-js"

import { assignPartyRoleWithClient } from "@/lib/services/party-roles"
import { recordAudit } from "@/lib/services/audit"
import type { RoleStatus } from "@/lib/directory/roles"

/**
 * Put a person into the directory the moment they become real to the org.
 *
 * Buyers used to enter as `prospect_contacts` rows — a shadow person table with
 * denormalized name, email, phone and a free-text company — and only became
 * directory contacts at hold time, and even then only the primary one. So an
 * active prospect could not be found by searching the directory, co-buyers and
 * co-op agents never arrived at all, and the same human could be created twice
 * with two spellings of their email.
 *
 * Promotion is now at the door, deduped, for every person on the record.
 */

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export interface PromotePersonInput {
  fullName: string
  email?: string | null
  phone?: string | null
  /** The directory role this person earns by existing here (prospect, buyer, agent…). */
  roleKey: string
  roleStatus?: RoleStatus
  /** Free-text company from an intake form. Becomes a real company row. */
  companyName?: string | null
  /** What they do at that company. */
  title?: string | null
}

export interface PromotedPerson {
  contactId: string
  companyId: string | null
  created: boolean
}

/**
 * Find-or-create the company behind a free-text name.
 *
 * An intake form gives "Coldwell Banker" as a string; a brokerage that refers
 * three buyers should be one row, not three strings. Matched on the same
 * normalized name the directory's uniqueness index uses.
 */
async function resolveCompanyByName(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  name: string,
  roleKey: string,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  const normalized = normalizeName(trimmed)
  if (!normalized) return null

  const { data: existing, error } = await supabase
    .from("companies")
    .select("id, name")
    .eq("org_id", orgId)
    .is("archived_at", null)
    .ilike("name", trimmed)
    .limit(5)

  if (error) throw new Error(`Failed to match company: ${error.message}`)
  const match = (existing ?? []).find(
    (row) => normalizeName((row as { name: string }).name) === normalized,
  )
  if (match) return (match as { id: string }).id

  const { data: created, error: createError } = await supabase
    .from("companies")
    .insert({ org_id: orgId, name: trimmed, company_type: "other", metadata: {} })
    .select("id")
    .single()

  if (createError || !created) throw new Error(`Failed to create company: ${createError?.message}`)

  await assignPartyRoleWithClient(supabase, orgId, userId, {
    kind: "company",
    partyId: created.id as string,
    roleKey,
    source: "promotion",
  })

  // Search indexing is driven off recordAudit. Without this the promoted company
  // stayed out of the command bar until some later edit happened to touch it.
  await recordAudit({
    orgId,
    actorId: userId ?? undefined,
    action: "insert",
    entityType: "company",
    entityId: created.id as string,
    after: created,
  })

  return created.id as string
}

export async function promotePersonToDirectoryWithClient(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  input: PromotePersonInput,
): Promise<PromotedPerson> {
  const fullName = input.fullName.trim()
  if (!fullName) throw new Error("A person needs a name to enter the directory")

  const email = input.email?.trim() || null
  const companyId = input.companyName
    ? await resolveCompanyByName(supabase, orgId, userId, input.companyName, "agent")
    : null

  // Email is the strong key; without one, fall back to an exact normalized-name
  // match. Deliberately NOT fuzzy: a wrong merge of two buyers is far worse than
  // a duplicate, and `directory_merge_candidates` exists to catch the rest.
  let contactId: string | null = null
  if (email) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .eq("email", email)
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Failed to match contact by email: ${error.message}`)
    contactId = (data as { id: string } | null)?.id ?? null
  }

  if (!contactId) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .ilike("full_name", fullName)
      .limit(5)
    if (error) throw new Error(`Failed to match contact by name: ${error.message}`)
    const normalized = normalizeName(fullName)
    const match = (data ?? []).find(
      (row) => normalizeName((row as { full_name: string }).full_name) === normalized,
    )
    contactId = (match as { id: string } | undefined)?.id ?? null
  }

  let created = false
  if (!contactId) {
    const { data, error } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        full_name: fullName,
        email,
        phone: input.phone?.trim() || null,
        role: input.title?.trim() || null,
        contact_type: "client",
        metadata: {},
      })
      .select("id")
      .single()
    if (error || !data) throw new Error(`Failed to create contact: ${error?.message}`)
    contactId = data.id as string
    created = true
    // Same reason as the company above: no audit row means no search document.
    await recordAudit({
      orgId,
      actorId: userId ?? undefined,
      action: "insert",
      entityType: "contact",
      entityId: contactId,
      after: data,
    })
  }

  await assignPartyRoleWithClient(supabase, orgId, userId, {
    kind: "contact",
    partyId: contactId,
    roleKey: input.roleKey,
    status: input.roleStatus,
    source: "promotion",
  })

  if (companyId) {
    const { error: linkError } = await supabase.from("contact_company_links").upsert(
      {
        org_id: orgId,
        contact_id: contactId,
        company_id: companyId,
        relationship: input.title?.trim() || "agent",
        is_primary: true,
        title: input.title?.trim() || null,
      },
      { onConflict: "contact_id,company_id" },
    )
    if (linkError) throw new Error(`Failed to link contact to company: ${linkError.message}`)
  }

  return { contactId, companyId, created }
}
