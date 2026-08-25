"use server"

import { revalidatePath } from "next/cache"

import {
  importDirectory,
  type DirectoryImportInput,
  type DirectoryImportResult,
} from "@/lib/services/directory-import"
import { listRelationshipTypes } from "@/lib/services/party-roles"
import type { RelationshipType } from "@/lib/directory/roles"

import { actionError, type ActionResult } from "@/lib/action-result"

export type {
  DirectoryImportInput,
  DirectoryImportMode,
  DirectoryImportResult,
  DirectoryImportRow,
} from "@/lib/services/directory-import"

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

/** The org's role vocabulary, for the directory create forms. */
export async function listRelationshipTypesAction(): Promise<ActionResult<RelationshipType[]>> {
  try {
    return { success: true, data: await listRelationshipTypes() }
  } catch (error) {
    return actionError(error)
  }
}
