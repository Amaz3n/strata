"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  createManualSpecSection,
  createSpecUpload,
  getSpecSection,
  listSpecUploads,
} from "@/lib/services/specs"
import {
  createManualSpecSectionSchema,
  createSpecUploadSchema,
  getSpecSectionSchema,
} from "@/lib/validation/specs"
import type { SpecSectionView, SpecUploadView } from "@/components/specs/types"

function revalidateSpecs(projectId: string) {
  revalidatePath(`/projects/${projectId}/specs`)
  revalidatePath(`/projects/${projectId}/submittals`)
}

export async function createSpecUploadAction(input: unknown): Promise<ActionResult<SpecUploadView>> {
  try {
    const parsed = createSpecUploadSchema.parse(input)
    const upload = await createSpecUpload(parsed)
    revalidateSpecs(parsed.project_id)
    return { success: true, data: upload as SpecUploadView }
  } catch (error) {
    return actionError(error)
  }
}

export async function createManualSpecSectionAction(input: unknown): Promise<ActionResult<SpecSectionView>> {
  try {
    const parsed = createManualSpecSectionSchema.parse(input)
    const section = await createManualSpecSection(parsed)
    revalidateSpecs(parsed.project_id)
    return { success: true, data: section as SpecSectionView }
  } catch (error) {
    return actionError(error)
  }
}

export async function getSpecSectionAction(input: unknown): Promise<ActionResult<SpecSectionView>> {
  try {
    const parsed = getSpecSectionSchema.parse(input)
    const section = await getSpecSection(parsed.section_id)
    if (!section || (section as { project_id?: string }).project_id !== parsed.project_id) {
      throw new Error("Spec section not found")
    }
    return { success: true, data: section as SpecSectionView }
  } catch (error) {
    return actionError(error)
  }
}

export async function listSpecUploadsAction(projectId: string): Promise<ActionResult<SpecUploadView[]>> {
  try {
    const uploads = await listSpecUploads(projectId)
    return { success: true, data: uploads as SpecUploadView[] }
  } catch (error) {
    return actionError(error)
  }
}
