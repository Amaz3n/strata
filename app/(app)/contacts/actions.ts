"use server"

import { revalidatePath } from "next/cache"

import {
  archiveContact,
  createContact,
  getContact,
  getContactAssignments,
  // portal
  linkContactToCompany,
  listContacts,
  unlinkContactFromCompany,
  updateContact,
} from "@/lib/services/contacts"
import {
  contactCompanyLinkSchema,
  contactFiltersSchema,
  contactInputSchema,
  contactUpdateSchema,
} from "@/lib/validation/contacts"
import { createPortalAccessToken } from "@/lib/services/portal-access"
import { requireOrgContext } from "@/lib/services/context"

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\""
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === "," && !inQuotes) {
      result.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  result.push(current.trim())
  return result
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase())
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    return headers.reduce<Record<string, string>>((acc, header, idx) => {
      acc[header] = values[idx] ?? ""
      return acc
    }, {})
  })
}

function normalizeContactType(value?: string) {
  const normalized = (value ?? "").trim().toLowerCase()
  const allowed = new Set(["internal", "subcontractor", "client", "vendor", "consultant"])
  return allowed.has(normalized) ? normalized : "subcontractor"
}

export async function listContactsAction(filters?: unknown) {
  const parsed = contactFiltersSchema.parse(filters ?? undefined) ?? undefined
  return listContacts(undefined, parsed)
}

export async function createContactAction(input: unknown) {
  const parsed = contactInputSchema.parse(input)
  const contact = await createContact({ input: parsed })
  revalidatePath("/contacts")
  revalidatePath("/directory")
  return contact
}

export async function updateContactAction(contactId: string, input: unknown) {
  const parsed = contactUpdateSchema.parse(input)
  const contact = await updateContact({ contactId, input: parsed })
  revalidatePath("/contacts")
  revalidatePath("/directory")
  return contact
}

export async function archiveContactAction(contactId: string) {
  await archiveContact(contactId)
  revalidatePath("/contacts")
  revalidatePath("/directory")
  return true
}

export async function linkContactToCompanyAction(input: unknown) {
  const parsed = contactCompanyLinkSchema.parse(input)
  await linkContactToCompany(parsed)
  revalidatePath("/contacts")
  revalidatePath("/directory")
  return true
}

export async function unlinkContactFromCompanyAction(contactId: string, companyId: string) {
  await unlinkContactFromCompany({ contactId, companyId })
  revalidatePath("/contacts")
  revalidatePath("/directory")
  return true
}

export async function contactAssignmentsAction(contactId: string) {
  return getContactAssignments(contactId)
}

export async function getContactAction(contactId: string) {
  const contact = await getContact(contactId)
  const assignments = await getContactAssignments(contactId)
  return { contact, assignments }
}

export async function sendPortalInviteAction({
  contactId,
  projectId,
  portalType = "sub",
}: {
  contactId: string
  projectId: string
  portalType?: "client" | "sub"
}) {
  const token = await createPortalAccessToken({
    projectId,
    portalType,
    contactId,
    permissions: {},
  })
  return token
}

export async function importContactsCsvAction(csvText: string) {
  if (!csvText?.trim()) return { created: 0 }

  const { supabase, orgId } = await requireOrgContext()
  const rows = parseCsv(csvText)

  if (!rows.length) return { created: 0 }

  const insertPayload = rows
    .map((row) => {
      const contact_type = normalizeContactType(row.contact_type)
      const payload = {
        full_name: row.full_name || row.name || "",
        email: row.email || undefined,
        phone: row.phone || undefined,
        role: row.role || undefined,
        contact_type,
        external_crm_id: row.external_crm_id || undefined,
        crm_source: row.crm_source || undefined,
        preferred_contact_method: row.preferred_contact_method || undefined,
        notes: row.notes || undefined,
      }
      const parsed = contactInputSchema.safeParse(payload)
      if (!parsed.success) return null

      return {
        org_id: orgId,
        full_name: parsed.data.full_name,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        role: parsed.data.role ?? null,
        contact_type: parsed.data.contact_type ?? "subcontractor",
        primary_company_id: parsed.data.primary_company_id ?? null,
        external_crm_id: parsed.data.external_crm_id ?? null,
        crm_source: parsed.data.crm_source ?? null,
        metadata: {
          has_portal_access: parsed.data.has_portal_access ?? false,
          preferred_contact_method: parsed.data.preferred_contact_method,
          notes: parsed.data.notes,
        },
      }
    })
    .filter(Boolean)

  if (!insertPayload.length) return { created: 0 }

  const { error } = await supabase.from("contacts").insert(insertPayload)
  if (error) {
    throw new Error(`Failed to import contacts: ${error.message}`)
  }

  revalidatePath("/contacts")
  revalidatePath("/directory")
  return { created: insertPayload.length }
 }

