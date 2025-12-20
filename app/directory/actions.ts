"use server"

import { revalidatePath } from "next/cache"

import { getCompanyContacts } from "@/lib/services/companies"

export async function getCompanyContactsForDirectoryAction(companyId: string) {
  const contacts = await getCompanyContacts(companyId)
  return contacts
}

// Convenience revalidation helper if needed in the future
export async function revalidateDirectory() {
  revalidatePath("/directory")
}
