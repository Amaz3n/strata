"use server"

import { revalidatePath } from "next/cache"

import {
  listDirectoryPage,
  type DirectoryPageInput,
  type DirectoryPageResult,
} from "@/lib/services/directory"
import {
  importDirectory,
  type DirectoryImportInput,
  type DirectoryImportResult,
} from "@/lib/services/directory-import"

import { actionError, type ActionResult } from "@/lib/action-result"

export type {
  DirectoryImportInput,
  DirectoryImportMode,
  DirectoryImportResult,
  DirectoryImportRow,
} from "@/lib/services/directory-import"

/** Page N+1 for the list's infinite scroll. Gated inside `listDirectoryPage`. */
export async function listDirectoryPageAction(
  input: DirectoryPageInput,
): Promise<DirectoryPageResult> {
  return listDirectoryPage(input)
}

export async function importDirectoryAction(
  input: DirectoryImportInput,
): Promise<ActionResult<DirectoryImportResult>> {
  try {
    const data = await importDirectory(input)
    revalidatePath("/directory")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}
