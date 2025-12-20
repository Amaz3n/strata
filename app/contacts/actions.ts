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



