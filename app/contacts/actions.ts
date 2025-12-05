"use server"

import { revalidatePath } from "next/cache"

import {
  archiveContact,
  createContact,
  getContactAssignments,
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

export async function listContactsAction(filters?: unknown) {
  const parsed = contactFiltersSchema.parse(filters ?? undefined) ?? undefined
  return listContacts(undefined, parsed)
}

export async function createContactAction(input: unknown) {
  const parsed = contactInputSchema.parse(input)
  const contact = await createContact({ input: parsed })
  revalidatePath("/contacts")
  return contact
}

export async function updateContactAction(contactId: string, input: unknown) {
  const parsed = contactUpdateSchema.parse(input)
  const contact = await updateContact({ contactId, input: parsed })
  revalidatePath("/contacts")
  return contact
}

export async function archiveContactAction(contactId: string) {
  await archiveContact(contactId)
  revalidatePath("/contacts")
  return true
}

export async function linkContactToCompanyAction(input: unknown) {
  const parsed = contactCompanyLinkSchema.parse(input)
  await linkContactToCompany(parsed)
  revalidatePath("/contacts")
  return true
}

export async function unlinkContactFromCompanyAction(contactId: string, companyId: string) {
  await unlinkContactFromCompany({ contactId, companyId })
  revalidatePath("/contacts")
  return true
}

export async function contactAssignmentsAction(contactId: string) {
  return getContactAssignments(contactId)
}
