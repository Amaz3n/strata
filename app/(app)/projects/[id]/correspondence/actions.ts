"use server"

import { revalidatePath } from "next/cache"

import { runAction, type ActionResult } from "@/lib/action-result"
import {
  archiveProjectEmails,
  confirmProjectEmailClassifications,
  linkProjectEmail,
  listCorrespondenceLinkTargets,
  reclassifyProjectEmails,
  unlinkProjectEmail,
  type CorrespondenceMessage,
  type LinkTarget,
} from "@/lib/services/correspondence"
import type {
  ArchiveInput,
  CorrespondenceSelection,
  LinkCorrespondenceInput,
  ReclassifyInput,
} from "@/lib/validation/correspondence"

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/correspondence`)
}

export async function reclassifyProjectEmailsAction(
  input: ReclassifyInput,
): Promise<ActionResult<CorrespondenceMessage[]>> {
  return runAction(async () => {
    const messages = await reclassifyProjectEmails(input)
    revalidate(input.projectId)
    return messages
  })
}

export async function confirmProjectEmailClassificationsAction(
  input: CorrespondenceSelection,
): Promise<ActionResult<CorrespondenceMessage[]>> {
  return runAction(async () => {
    const messages = await confirmProjectEmailClassifications(input)
    revalidate(input.projectId)
    return messages
  })
}

export async function archiveProjectEmailsAction(
  input: ArchiveInput,
): Promise<ActionResult<CorrespondenceMessage[]>> {
  return runAction(async () => {
    const messages = await archiveProjectEmails(input)
    revalidate(input.projectId)
    return messages
  })
}

export async function linkProjectEmailAction(
  input: LinkCorrespondenceInput,
): Promise<ActionResult<CorrespondenceMessage>> {
  return runAction(async () => {
    const message = await linkProjectEmail(input)
    revalidate(input.projectId)
    return message
  })
}

export async function unlinkProjectEmailAction(input: {
  projectId: string
  emailId: string
  linkId: string
}): Promise<ActionResult<CorrespondenceMessage>> {
  return runAction(async () => {
    const message = await unlinkProjectEmail(input)
    revalidate(input.projectId)
    return message
  })
}

export async function listCorrespondenceLinkTargetsAction(input: {
  projectId: string
  entityType: LinkCorrespondenceInput["entityType"]
  search?: string
}): Promise<ActionResult<LinkTarget[]>> {
  return runAction(() => listCorrespondenceLinkTargets(input))
}
