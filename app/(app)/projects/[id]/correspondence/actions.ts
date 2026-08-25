"use server"

import { revalidatePath } from "next/cache"

import { runAction, type ActionResult } from "@/lib/action-result"
import {
  archiveProjectEmails,
  confirmProjectEmailClassifications,
  getCorrespondenceThread,
  getProjectEmail,
  linkProjectEmail,
  listArchivedCorrespondence,
  listCorrespondenceLinkTargets,
  listCorrespondenceThreads,
  reclassifyProjectEmails,
  unlinkProjectEmail,
  type ArchivedCorrespondencePage,
  type CorrespondenceMessage,
  type CorrespondenceThreadDetail,
  type CorrespondenceThreadPage,
  type LinkTarget,
  type ProjectEmailDetail,
} from "@/lib/services/correspondence"
import type {
  ArchiveInput,
  ArchivedCorrespondenceFilterInput,
  CorrespondenceFilterInput,
  CorrespondenceSelection,
  LinkCorrespondenceInput,
  ReclassifyInput,
} from "@/lib/validation/correspondence"

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/correspondence`)
}

export async function listCorrespondenceThreadsAction(
  input: CorrespondenceFilterInput,
): Promise<ActionResult<CorrespondenceThreadPage>> {
  return runAction(() => listCorrespondenceThreads(input))
}

export async function listArchivedCorrespondenceAction(
  input: ArchivedCorrespondenceFilterInput,
): Promise<ActionResult<ArchivedCorrespondencePage>> {
  return runAction(() => listArchivedCorrespondence(input))
}

export async function getCorrespondenceThreadAction(input: {
  projectId: string
  threadId: string
}): Promise<ActionResult<CorrespondenceThreadDetail>> {
  return runAction(async () => {
    const thread = await getCorrespondenceThread(input)
    if (!thread) throw new Error("That conversation is no longer in this project's log.")
    return thread
  })
}

export async function getProjectEmailAction(input: {
  projectId: string
  emailId: string
}): Promise<ActionResult<ProjectEmailDetail>> {
  return runAction(async () => {
    const email = await getProjectEmail(input.emailId, input.projectId)
    if (!email) throw new Error("That email is no longer in this project's log.")
    return email
  })
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
