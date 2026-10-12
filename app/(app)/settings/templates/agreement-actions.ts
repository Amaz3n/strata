"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, runAction, type ActionResult } from "@/lib/action-result"
import {
  createAgreementTemplate,
  createAgreementTemplateVersion,
  deleteAgreementTemplateDraft,
  getAgreementTemplate,
  publishAgreementTemplateVersion,
  retireAgreementTemplate,
  updateAgreementTemplate,
  updateAgreementTemplateDraft,
  withdrawAgreementTemplateVersion,
} from "@/lib/services/agreement-templates"

const PATH = "/settings/templates"
const MAX_PDF_BYTES = 15 * 1024 * 1024

async function mutate<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  const result = await runAction(work)
  if (result.success) revalidatePath(PATH)
  return result
}

export async function getAgreementTemplateAction(templateId: string) {
  return runAction(() => getAgreementTemplate({ templateId }))
}

export async function createAgreementTemplateAction(input: unknown) {
  return mutate(() => createAgreementTemplate(input))
}

export async function updateAgreementTemplateAction(input: unknown) {
  return mutate(() => updateAgreementTemplate(input))
}

export async function retireAgreementTemplateAction(templateId: string) {
  return mutate(() => retireAgreementTemplate({ templateId }))
}

const draftFieldsSchema = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The draft details could not be read" })
    return z.NEVER
  }
})

/** A new draft version: counsel's PDF plus where it applies. */
export async function createAgreementTemplateVersionAction(formData: FormData) {
  try {
    const file = formData.get("file")
    if (!(file instanceof File) || !file.size || file.size > MAX_PDF_BYTES) throw new Error("Choose a PDF smaller than 15 MB")
    const fields = draftFieldsSchema.parse(formData.get("fields"))
    const bytes = new Uint8Array(await file.arrayBuffer())
    return await mutate(() => createAgreementTemplateVersion(fields, { bytes, fileName: file.name }))
  } catch (error) {
    return actionError(error)
  }
}

export async function updateAgreementTemplateDraftAction(input: unknown) {
  return mutate(() => updateAgreementTemplateDraft(input))
}

export async function deleteAgreementTemplateDraftAction(versionId: string) {
  return mutate(() => deleteAgreementTemplateDraft({ versionId }))
}

export async function publishAgreementTemplateVersionAction(versionId: string) {
  return mutate(() => publishAgreementTemplateVersion({ versionId }))
}

export async function withdrawAgreementTemplateVersionAction(input: unknown) {
  return mutate(() => withdrawAgreementTemplateVersion(input))
}
