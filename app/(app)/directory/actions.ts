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

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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

function normalizeDirectoryName(value?: string) {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
  return normalized || undefined
}

async function resolveDirectoryCompanyClassification(
  supabase: SupabaseClient,
  orgId: string,
  companyType: CompanyType,
  trade?: string,
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
              metadata: { source: "directory_import" },
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

  const { data: existing, error: existingError } = await supabase
    .from("companies")
    .select("id, name")
    .eq("org_id", orgId)
    .is("metadata->>archived_at", null)

  if (existingError) {
    throw new Error(`Failed to check existing companies: ${existingError.message}`)
  }

  for (const row of existing ?? []) {
    const key = String(row.name).trim().toLowerCase()
    if (wanted.has(key)) map.set(key, row.id as string)
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
    const enrichedToCreate = await Promise.all(
      toCreate.map(async (row) => ({
        ...row,
        ...(await resolveDirectoryCompanyClassification(
          supabase,
          orgId,
          row.company_type,
          (row.metadata as { trade?: string | undefined }).trade,
        )),
      })),
    )
    const { data, error } = await supabase
      .from("companies")
      .insert(enrichedToCreate)
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
): Promise<ActionResult<DirectoryImportResult>> {
  return run(async () => {
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
      let skipped = 0

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
        const candidates: Array<{
          emailKey?: string
          nameCompanyKey: string
          companyId?: string
          payload: Record<string, unknown>
        }> = []
        const batchKeys = new Set<string>()
        rows.forEach((row, index) => {
          const fullName = trimOrUndefined(row.full_name)
          // In "both" mode a row can be company-only; skip the contact silently.
          if (!fullName) {
            if (mode === "contacts") {
              errors.push({ row: index + 1, reason: "Missing name" })
              skipped += 1
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
            skipped += 1
            return
          }

          const companyId =
            mode === "both"
              ? companyMap.get((row.company_name ?? "").trim().toLowerCase())
              : undefined
          const emailKey = parsed.data.email?.trim().toLowerCase()
          const nameCompanyKey = `${parsed.data.full_name.trim().toLowerCase()}::${companyId ?? "none"}`
          const batchKey = emailKey ? `email:${emailKey}` : `name-company:${nameCompanyKey}`
          if (batchKeys.has(batchKey)) {
            skipped += 1
            return
          }
          batchKeys.add(batchKey)

          candidates.push({
            emailKey,
            nameCompanyKey,
            companyId,
            payload: {
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
            },
          })
        })

        const existingByEmail = new Map<string, { id: string; primary_company_id?: string | null }>()
        const existingByNameCompany = new Map<string, { id: string; primary_company_id?: string | null }>()
        if (candidates.length > 0) {
          const { data: existingContacts, error: existingContactsError } = await supabase
            .from("contacts")
            .select("id, full_name, email, primary_company_id")
            .eq("org_id", orgId)
            .is("metadata->>archived_at", null)

          if (existingContactsError) {
            throw new Error(`Failed to check existing contacts: ${existingContactsError.message}`)
          }

          for (const contact of existingContacts ?? []) {
            const existing = {
              id: contact.id as string,
              primary_company_id: contact.primary_company_id as string | null | undefined,
            }
            const email = String(contact.email ?? "").trim().toLowerCase()
            if (email) existingByEmail.set(email, existing)
            const nameKey = `${String(contact.full_name ?? "").trim().toLowerCase()}::${contact.primary_company_id ?? "none"}`
            existingByNameCompany.set(nameKey, existing)
          }
        }

        const insertPayload: Array<Record<string, unknown>> = []
        const linkPayload: Array<{ org_id: string; contact_id: string; company_id: string; relationship: string }> = []
        for (const candidate of candidates) {
          const existing = candidate.emailKey
            ? existingByEmail.get(candidate.emailKey)
            : existingByNameCompany.get(candidate.nameCompanyKey)
          if (existing) {
            skipped += 1
            if (candidate.companyId) {
              linkPayload.push({
                org_id: orgId,
                contact_id: existing.id,
                company_id: candidate.companyId,
                relationship: "primary",
              })
            }
            continue
          }
          insertPayload.push(candidate.payload)
        }

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
          linkPayload.push(...links)
        }

        if (linkPayload.length > 0) {
          const { error: linkError } = await supabase
            .from("contact_company_links")
            .upsert(linkPayload, { onConflict: "contact_id,company_id" })
          if (linkError) {
            throw new Error(`Failed to link imported contacts: ${linkError.message}`)
          }
        }
      }

      if (contactsCreated === 0 && companiesCreated === 0) {
        return { ...empty, skipped: Math.max(skipped, total), errors }
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
  })
}
