"use server"

import { revalidatePath } from "next/cache"

import { getCompanyContacts } from "@/lib/services/companies"
import {
  listDirectoryPage,
  type DirectoryPageInput,
  type DirectoryPageResult,
} from "@/lib/services/directory"

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
