"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  addPlatformBugComment,
  archivePlatformBug,
  createPlatformBug,
  deletePlatformBug,
  listPlatformBugProjectsForOrg,
  startPlatformBugAiFix,
  startPlatformBugAiReview,
  uploadPlatformBugAttachments,
  updatePlatformBug,
} from "@/lib/services/platform-bugs"
import {
  PLATFORM_BUG_PRIORITIES,
  PLATFORM_BUG_STATUSES,
  type PlatformBugInput,
  type PlatformBugUpdate,
} from "@/lib/platform-bugs/types"

const optionalText = z.string().trim().max(4000).optional().nullable()
const optionalShortText = z.string().trim().max(240).optional().nullable()

function isSupportedAttachment(file: File) {
  const lowerName = file.name.toLowerCase()
  return file.type.startsWith("image/") || file.type === "application/pdf" || lowerName.endsWith(".pdf")
}

const bugPayloadSchema = z.object({
  title: z.string().trim().min(2, "Bug title is required.").max(180),
  description: optionalText,
  status: z.enum(PLATFORM_BUG_STATUSES).default("triage"),
  priority: z.enum(PLATFORM_BUG_PRIORITIES).default("medium"),
  source: optionalShortText,
  environment: optionalShortText,
  orgId: z.string().uuid().optional().or(z.literal("")),
  projectId: z.string().uuid().optional().or(z.literal("")),
  expectedBehavior: optionalText,
  actualBehavior: optionalText,
  assigneeUserId: z.string().uuid().optional().or(z.literal("")),
  dueAt: z.string().optional().or(z.literal("")),
  attachmentNames: z.array(z.string().trim().max(240)).default([]),
})

const updateBugSchema = bugPayloadSchema.partial()

function cleanOptional(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizePayload(payload: z.infer<typeof bugPayloadSchema>): PlatformBugInput {
  return {
    title: payload.title,
    description: cleanOptional(payload.description),
    status: payload.status,
    priority: payload.priority,
    source: cleanOptional(payload.source),
    environment: cleanOptional(payload.environment),
    orgId: cleanOptional(payload.orgId),
    projectId: cleanOptional(payload.projectId),
    expectedBehavior: cleanOptional(payload.expectedBehavior),
    actualBehavior: cleanOptional(payload.actualBehavior),
    assigneeUserId: cleanOptional(payload.assigneeUserId),
    dueAt: cleanOptional(payload.dueAt),
    attachmentNames: payload.attachmentNames,
  }
}

function normalizeUpdatePayload(payload: z.infer<typeof updateBugSchema>): PlatformBugUpdate {
  const update: PlatformBugUpdate = {}
  if (payload.title !== undefined) update.title = payload.title
  if (payload.description !== undefined) update.description = cleanOptional(payload.description)
  if (payload.status !== undefined) update.status = payload.status
  if (payload.priority !== undefined) update.priority = payload.priority
  if (payload.source !== undefined) update.source = cleanOptional(payload.source)
  if (payload.environment !== undefined) update.environment = cleanOptional(payload.environment)
  if (payload.orgId !== undefined) update.orgId = cleanOptional(payload.orgId)
  if (payload.projectId !== undefined) update.projectId = cleanOptional(payload.projectId)
  if (payload.expectedBehavior !== undefined) update.expectedBehavior = cleanOptional(payload.expectedBehavior)
  if (payload.actualBehavior !== undefined) update.actualBehavior = cleanOptional(payload.actualBehavior)
  if (payload.assigneeUserId !== undefined) update.assigneeUserId = cleanOptional(payload.assigneeUserId)
  if (payload.dueAt !== undefined) update.dueAt = cleanOptional(payload.dueAt)
  if (payload.attachmentNames !== undefined) update.attachmentNames = payload.attachmentNames
  return update
}

export async function createPlatformBugAction(payload: unknown) {
  const parsed = bugPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Please check the bug fields." }
  }

  try {
    const bug = await createPlatformBug(normalizePayload(parsed.data))
    revalidatePath("/platform/bugs")
    return { bug }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to create bug." }
  }
}

export async function createPlatformBugFromFormAction(formData: FormData) {
  const files = formData
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0)

  if (files.some((file) => !isSupportedAttachment(file))) {
    return { error: "Attachments must be images or PDFs." }
  }

  const payload = {
    title: formData.get("title"),
    description: formData.get("description"),
    status: formData.get("status"),
    priority: formData.get("priority"),
    assigneeUserId: formData.get("assigneeUserId") === "none" ? "" : formData.get("assigneeUserId"),
    orgId: formData.get("orgId") === "none" ? "" : formData.get("orgId"),
    projectId: formData.get("projectId") === "none" ? "" : formData.get("projectId"),
    attachmentNames: files.map((file) => file.name),
  }

  const parsed = bugPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Please check the bug fields." }
  }

  try {
    const bug = await createPlatformBug(normalizePayload(parsed.data))
    const attachmentNames = files.length > 0
      ? await uploadPlatformBugAttachments({
          bugId: bug.id,
          files,
          attachmentNames: parsed.data.attachmentNames,
        })
      : parsed.data.attachmentNames

    revalidatePath("/platform/bugs")
    return { bug: { ...bug, attachment_names: attachmentNames } }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to create bug." }
  }
}

export async function updatePlatformBugAction(id: string, payload: unknown) {
  const parsed = updateBugSchema.safeParse(payload)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Please check the bug fields." }
  }

  try {
    const bug = await updatePlatformBug(id, normalizeUpdatePayload(parsed.data))
    revalidatePath("/platform/bugs")
    return { bug }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to update bug." }
  }
}

export async function addPlatformBugCommentAction(id: string, body: string) {
  const parsed = z.string().trim().min(1, "Comment cannot be empty.").max(4000).safeParse(body)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Comment cannot be empty." }
  }

  try {
    await addPlatformBugComment(id, parsed.data)
    revalidatePath("/platform/bugs")
    return { ok: true }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to add comment." }
  }
}

export async function listPlatformBugProjectsAction(orgId: string) {
  const parsed = z.string().uuid().safeParse(orgId)
  if (!parsed.success) return { projects: [] }

  try {
    const projects = await listPlatformBugProjectsForOrg(parsed.data)
    return { projects }
  } catch (error: any) {
    return { projects: [], error: error?.message ?? "Unable to load projects." }
  }
}

export async function archivePlatformBugAction(id: string) {
  try {
    await archivePlatformBug(id)
    revalidatePath("/platform/bugs")
    return { ok: true }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to archive bug." }
  }
}

export async function deletePlatformBugAction(id: string) {
  try {
    await deletePlatformBug(id)
    revalidatePath("/platform/bugs")
    return { ok: true }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to delete bug." }
  }
}

export async function startPlatformBugAiReviewAction(id: string) {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) {
    return { error: "Invalid issue id." }
  }

  try {
    const review = await startPlatformBugAiReview(parsed.data)
    revalidatePath("/platform/bugs")
    return { review }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to start Codex review." }
  }
}

export async function startPlatformBugAiFixAction(id: string) {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) {
    return { error: "Invalid issue id." }
  }

  try {
    const fix = await startPlatformBugAiFix(parsed.data)
    revalidatePath("/platform/bugs")
    return { fix }
  } catch (error: any) {
    return { error: error?.message ?? "Unable to start Codex fix PR." }
  }
}
