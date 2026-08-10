"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { CORRESPONDENCE_CLASSIFICATIONS } from "@/lib/correspondence"
import {
  enableProjectCorrespondence,
  getProjectEmail,
  logProjectEmailAsChangeEvent,
  reclassifyProjectEmail,
  unlinkProjectEmail,
  type ProjectCorrespondenceInbox,
  type ProjectCorrespondenceRow,
  type ProjectEmailDetail,
} from "@/lib/services/project-email-ingest"

const projectSchema = z.object({ projectId: z.string().uuid() })
const emailSchema = projectSchema.extend({ emailId: z.string().uuid() })
const reclassifySchema = emailSchema.extend({ classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS) })

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/correspondence`)
}

export async function enableProjectCorrespondenceAction(
  input: z.input<typeof projectSchema>,
): Promise<ActionResult<ProjectCorrespondenceInbox>> {
  try {
    const { projectId } = projectSchema.parse(input)
    const inbox = await enableProjectCorrespondence(projectId)
    revalidate(projectId)
    return { success: true, data: inbox }
  } catch (error) {
    return actionError(error, "Could not enable email filing for this project.")
  }
}

export async function getProjectEmailAction(
  input: z.input<typeof emailSchema>,
): Promise<ActionResult<ProjectEmailDetail>> {
  try {
    const { projectId, emailId } = emailSchema.parse(input)
    const email = await getProjectEmail(emailId, projectId)
    if (!email) return { success: false, error: "That email is no longer in this project's log." }
    return { success: true, data: email }
  } catch (error) {
    return actionError(error, "Could not open that email.")
  }
}

export async function reclassifyProjectEmailAction(
  input: z.input<typeof reclassifySchema>,
): Promise<ActionResult<ProjectCorrespondenceRow>> {
  try {
    const parsed = reclassifySchema.parse(input)
    const row = await reclassifyProjectEmail(parsed)
    revalidate(parsed.projectId)
    return { success: true, data: row }
  } catch (error) {
    return actionError(error, "Could not update the classification.")
  }
}

export async function logProjectEmailAsChangeEventAction(
  input: z.input<typeof emailSchema>,
): Promise<ActionResult<ProjectCorrespondenceRow>> {
  try {
    const parsed = emailSchema.parse(input)
    const row = await logProjectEmailAsChangeEvent(parsed)
    revalidate(parsed.projectId)
    return { success: true, data: row }
  } catch (error) {
    return actionError(error, "Could not create a change event from this email.")
  }
}

export async function unlinkProjectEmailAction(
  input: z.input<typeof emailSchema>,
): Promise<ActionResult<ProjectCorrespondenceRow>> {
  try {
    const parsed = emailSchema.parse(input)
    const row = await unlinkProjectEmail(parsed)
    revalidate(parsed.projectId)
    return { success: true, data: row }
  } catch (error) {
    return actionError(error, "Could not remove the link.")
  }
}
