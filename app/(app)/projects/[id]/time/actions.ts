"use server"

import { revalidatePath } from "next/cache"

import { requireOrgContext } from "@/lib/services/context"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { hasPermission } from "@/lib/services/permissions"
import {
  approveTimeEntry,
  createTimeEntry,
  createTimeEntryApprovalLink,
  listCostPlusTabData,
  rejectTimeEntry,
} from "@/lib/services/cost-plus"

export interface CrewLineInput {
  workerUserId?: string | null
  workerName: string
  hours: number
  baseRateDollars: number
  burdenMultiplier?: number
  isBillable?: boolean
  costCodeId?: string | null
}

export interface CreateTimeEntriesInput {
  workDate: string
  burdenMultiplier: number
  isBillable: boolean
  isOvertime: boolean
  notes?: string | null
  crew: CrewLineInput[]
}

export interface CreateMyTimeEntryInput {
  workDate: string
  hours: number
  notes?: string | null
}

export async function createTimeEntriesAction(projectId: string, formData: FormData) {
  const { orgId } = await requireOrgContext()
  const payload = JSON.parse(String(formData.get("payload") ?? "{}")) as CreateTimeEntriesInput

  const crew = (payload.crew ?? []).filter((line) => line.workerName.trim().length > 0 && line.hours > 0)
  if (crew.length === 0) {
    throw new Error("Add at least one worker with hours")
  }

  const attachmentId = await uploadCostPlusFile({
    file: formData.get("attachment") as File | null,
    orgId,
    projectId,
    kind: "time_attachment",
  })
  const attachedFileIds = attachmentId ? [attachmentId] : []

  const workDate = new Date(payload.workDate)
  for (const line of crew) {
    await createTimeEntry({
      projectId,
      costCodeId: line.costCodeId ?? null,
      workerUserId: line.workerUserId ?? null,
      workerName: line.workerName.trim(),
      workDate,
      hours: line.hours,
      baseRateCents: Math.round((line.baseRateDollars || 0) * 100),
      burdenMultiplier: line.burdenMultiplier || payload.burdenMultiplier || 1,
      isBillable: line.isBillable ?? payload.isBillable,
      isOvertime: payload.isOvertime,
      notes: payload.notes ?? null,
      attachedFileIds,
    })
  }

  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/financials`)

  const data = await listCostPlusTabData(projectId).catch(() => ({ timeEntries: [] as any[] }))
  return data.timeEntries ?? []
}

export async function createMyTimeEntryAction(projectId: string, formData: FormData) {
  const { orgId } = await requireOrgContext()
  const payload = JSON.parse(String(formData.get("payload") ?? "{}")) as CreateMyTimeEntryInput
  if (!payload.hours || payload.hours <= 0) {
    throw new Error("Enter how many hours you worked")
  }

  const attachmentId = await uploadCostPlusFile({
    file: formData.get("attachment") as File | null,
    orgId,
    projectId,
    kind: "time_attachment",
  })

  await createTimeEntry({
    projectId,
    workDate: new Date(payload.workDate),
    hours: payload.hours,
    baseRateCents: 0,
    burdenMultiplier: 1,
    isBillable: true,
    isOvertime: false,
    notes: payload.notes ?? null,
    attachedFileIds: attachmentId ? [attachmentId] : [],
  })

  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)

  const data = await listCostPlusTabData(projectId).catch(() => ({ timeEntries: [] as any[] }))
  return data.timeEntries ?? []
}

export async function listProjectTimeEntriesAction(projectId: string) {
  const data = await listCostPlusTabData(projectId).catch(() => ({ timeEntries: [] as any[] }))
  return data.timeEntries ?? []
}

export async function canManageCrewTimeAction() {
  return hasPermission("bill.approve")
}

export async function approveTimeEntryFormAction(projectId: string, timeEntryId: string) {
  await approveTimeEntry(timeEntryId)
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/financials`)
}

export async function rejectTimeEntryFormAction(projectId: string, timeEntryId: string) {
  await rejectTimeEntry(timeEntryId)
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/financials`)
}

export async function createTimeEntryApprovalLinkFormAction(projectId: string, timeEntryId: string) {
  const link = await createTimeEntryApprovalLink(timeEntryId)
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/financials`)
  return link
}
