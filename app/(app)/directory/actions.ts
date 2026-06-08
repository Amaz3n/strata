"use server"

import { revalidatePath } from "next/cache"

import { getCompanyContacts } from "@/lib/services/companies"
import {
  listDirectoryPage,
  type DirectoryPageInput,
  type DirectoryPageResult,
} from "@/lib/services/directory"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { recordEvent } from "@/lib/services/events"
import { contactInputSchema } from "@/lib/validation/contacts"
import { companyInputSchema } from "@/lib/validation/companies"
import type { CompanyType, ContactType } from "@/lib/types"
import type { SupabaseClient } from "@supabase/supabase-js"

export async function getCompanyContactsForDirectoryAction(companyId: string) {
  const contacts = await getCompanyContacts(companyId)
  return contacts
}

export async function listDirectoryPageAction(
  input: DirectoryPageInput,
): Promise<DirectoryPageResult> {
  return listDirectoryPage(input)
}

// Convenience revalidation helper if needed in the future
export async function revalidateDirectory() {
  revalidatePath("/directory")
}

const CONTACT_TYPES: ContactType[] = [
  "internal",
  "subcontractor",
  "client",
  "vendor",
  "consultant",
]

const COMPANY_TYPES: CompanyType[] = [
  "subcontractor",
  "supplier",
  "client",
  "architect",
  "engineer",
  "other",
]

function normalizeContactType(value?: string, fallback: ContactType = "subcontractor"): ContactType {
  const normalized = (value ?? "").trim().toLowerCase()
  return (CONTACT_TYPES as string[]).includes(normalized)
    ? (normalized as ContactType)
    : fallback
}

function normalizeCompanyType(value?: string, fallback: CompanyType = "subcontractor"): CompanyType {
  const normalized = (value ?? "").trim().toLowerCase()
  // Common synonyms from real-world vendor lists.
  if (normalized === "vendor") return "supplier"
  if (normalized === "sub" || normalized === "trade") return "subcontractor"
  return (COMPANY_TYPES as string[]).includes(normalized)
    ? (normalized as CompanyType)
    : fallback
}

export type DirectoryImportMode = "contacts" | "companies" | "both"

export interface DirectoryImportRow {
  // Contact fields
  full_name?: string
  contact_email?: string
  contact_phone?: string
  contact_address?: string
  role?: string
  contact_type?: string
  notes?: string
  // Company fields
  company_name?: string
  company_type?: string
  trade?: string
  company_email?: string
  company_phone?: string
  website?: string
  company_address?: string
}

export interface DirectoryImportResult {
  contactsCreated: number
  companiesCreated: number
  skipped: number
  total: number
  errors: Array<{ row: number; reason: string }>
}

export interface DirectoryImportInput {
  mode: DirectoryImportMode
  rows: DirectoryImportRow[]
  defaultContactType?: ContactType
  defaultCompanyType?: CompanyType
}

const trimOrUndefined = (value?: string) => {
  const t = value?.trim()
  return t ? t : undefined
}

/**
 * Find-or-create companies by (case-insensitive) name within the org, deduped
 * across the batch. Returns a map of lowercased-name -> company id plus the
 * number of newly created companies.
 */
async function resolveCompanies(
  supabase: SupabaseClient,
  orgId: string,
  wanted: Map<string, { name: string; type: CompanyType; trade?: string; email?: string; phone?: string; website?: string; address?: string }>,
): Promise<{ map: Map<string, string>; created: number }> {
  const map = new Map<string, string>()
  if (wanted.size === 0) return { map, created: 0 }

  const names = Array.from(wanted.values()).map((c) => c.name)
  const { data: existing } = await supabase
    .from("companies")
    .select("id, name")
    .eq("org_id", orgId)
    .in("name", names)

  for (const row of existing ?? []) {
    map.set(String(row.name).trim().toLowerCase(), row.id as string)
  }

  const toCreate = Array.from(wanted.entries())
    .filter(([key]) => !map.has(key))
    .map(([, c]) => {
      const parsed = companyInputSchema.safeParse({
        name: c.name,
        company_type: c.type,
        trade: c.trade,
        email: c.email,
        phone: c.phone,
        website: c.website,
        address: c.address ? { formatted: c.address } : undefined,
      })
      if (!parsed.success) return null
      return {
        org_id: orgId,
        name: parsed.data.name,
        company_type: parsed.data.company_type,
        phone: parsed.data.phone ?? null,
        email: parsed.data.email ?? null,
        website: parsed.data.website ?? null,
        address: parsed.data.address ?? null,
        metadata: { trade: parsed.data.trade },
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  let created = 0
  if (toCreate.length > 0) {
    const { data, error } = await supabase
      .from("companies")
      .insert(toCreate)
      .select("id, name")
    if (error) {
      throw new Error(`Failed to import companies: ${error.message}`)
    }
    for (const row of data ?? []) {
      map.set(String(row.name).trim().toLowerCase(), row.id as string)
      created += 1
    }
  }

  return { map, created }
}

/**
 * Bulk-import directory records from already-parsed + column-mapped rows.
 *
 * - `contacts`  → people only
 * - `companies` → businesses/vendors only (deduped by name)
 * - `both`      → each row is a company plus its primary contact; companies are
 *                 found-or-created and the contact is linked to them
 *
 * Each row is validated individually so a few bad rows don't sink the batch.
 */
export async function importDirectoryAction(
  input: DirectoryImportInput,
): Promise<DirectoryImportResult> {
  const rows = Array.isArray(input?.rows) ? input.rows : []
  const total = rows.length
  const empty: DirectoryImportResult = {
    contactsCreated: 0,
    companiesCreated: 0,
    skipped: 0,
    total,
    errors: [],
  }
  if (!total) return empty

  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAnyPermission(["org.member", "directory.write"], {
    supabase,
    orgId,
    userId,
  })

  const mode: DirectoryImportMode = input.mode ?? "contacts"
  const defaultContactType = input.defaultContactType ?? "subcontractor"
  const defaultCompanyType = input.defaultCompanyType ?? "subcontractor"
  const errors: DirectoryImportResult["errors"] = []

  // 1. Resolve companies first (companies + both modes).
  let companyMap = new Map<string, string>()
  let companiesCreated = 0
  if (mode === "companies" || mode === "both") {
    const wanted = new Map<
      string,
      { name: string; type: CompanyType; trade?: string; email?: string; phone?: string; website?: string; address?: string }
    >()
    rows.forEach((row) => {
      const name = trimOrUndefined(row.company_name)
      if (!name) return
      const key = name.toLowerCase()
      if (!wanted.has(key)) {
        wanted.set(key, {
          name,
          type: normalizeCompanyType(row.company_type, defaultCompanyType),
          trade: trimOrUndefined(row.trade),
          email: trimOrUndefined(row.company_email),
          phone: trimOrUndefined(row.company_phone),
          website: trimOrUndefined(row.website),
          address: trimOrUndefined(row.company_address),
        })
      }
    })
    const resolved = await resolveCompanies(supabase, orgId, wanted)
    companyMap = resolved.map
    companiesCreated = resolved.created
  }

  // 2. Build contact inserts (contacts + both modes).
  let contactsCreated = 0
  if (mode === "contacts" || mode === "both") {
    const insertPayload: Array<Record<string, unknown>> = []
    rows.forEach((row, index) => {
      const fullName = trimOrUndefined(row.full_name)
      // In "both" mode a row can be company-only; skip the contact silently.
      if (!fullName) {
        if (mode === "contacts") {
          errors.push({ row: index + 1, reason: "Missing name" })
        }
        return
      }

      const parsed = contactInputSchema.safeParse({
        full_name: fullName,
        email: trimOrUndefined(row.contact_email),
        phone: trimOrUndefined(row.contact_phone),
        address: trimOrUndefined(row.contact_address),
        role: trimOrUndefined(row.role),
        contact_type: normalizeContactType(row.contact_type, defaultContactType),
        notes: trimOrUndefined(row.notes),
      })
      if (!parsed.success) {
        errors.push({
          row: index + 1,
          reason: parsed.error.issues[0]?.message ?? "Invalid row",
        })
        return
      }

      const companyId =
        mode === "both"
          ? companyMap.get((row.company_name ?? "").trim().toLowerCase())
          : undefined

      insertPayload.push({
        org_id: orgId,
        full_name: parsed.data.full_name,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        address: parsed.data.address ? { formatted: parsed.data.address } : null,
        role: parsed.data.role ?? null,
        contact_type: parsed.data.contact_type ?? defaultContactType,
        primary_company_id: companyId ?? null,
        metadata: {
          has_portal_access: false,
          notes: parsed.data.notes,
        },
      })
    })

    if (insertPayload.length > 0) {
      const { data, error } = await supabase
        .from("contacts")
        .insert(insertPayload)
        .select("id, primary_company_id")
      if (error) {
        throw new Error(`Failed to import contacts: ${error.message}`)
      }
      contactsCreated = data?.length ?? insertPayload.length

      // Mirror createContact: maintain the contact_company_links join rows.
      const links = (data ?? [])
        .filter((c) => c.primary_company_id)
        .map((c) => ({
          org_id: orgId,
          contact_id: c.id,
          company_id: c.primary_company_id,
          relationship: "primary",
        }))
      if (links.length > 0) {
        await supabase
          .from("contact_company_links")
          .upsert(links, { onConflict: "contact_id,company_id" })
      }
    }
  }

  const skipped = Math.max(0, total - Math.max(contactsCreated, companiesCreated))

  if (contactsCreated === 0 && companiesCreated === 0) {
    return { ...empty, skipped: total, errors }
  }

  await recordEvent({
    orgId,
    eventType: "directory_imported",
    entityType: "contact",
    entityId: orgId,
    payload: {
      mode,
      contacts: contactsCreated,
      companies: companiesCreated,
      source: "csv",
    },
  }).catch(() => {})

  revalidatePath("/contacts")
  revalidatePath("/companies")
  revalidatePath("/directory")

  return {
    contactsCreated,
    companiesCreated,
    skipped,
    total,
    errors,
  }
}
