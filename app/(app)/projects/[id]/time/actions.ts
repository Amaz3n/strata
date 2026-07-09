"use server"

import { revalidatePath } from "next/cache"

import { requireOrgContext } from "@/lib/services/context"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { hasPermission } from "@/lib/services/permissions"
import {
  approveTimeEntry,
  createTimeEntry,
  createTimeEntryApprovalLink,
  listProjectTimeEntries,
  rejectTimeEntry,
} from "@/lib/services/cost-plus"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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
  otMultiplier?: number
  isDoubleTime?: boolean
  dtMultiplier?: number
  notes?: string | null
  crew: CrewLineInput[]
}

export interface CreateMyTimeEntryInput {
  workDate: string
  hours: number
  isOvertime?: boolean
  otMultiplier?: number
  isDoubleTime?: boolean
  dtMultiplier?: number
  notes?: string | null
}

function revalidateProjectTimeFinancials(projectId: string) {
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/review`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
}

export async function createTimeEntriesAction(projectId: string, formData: FormData) {
  return run(async () => {
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
          otMultiplier: payload.otMultiplier ?? 1.5,
          isDoubleTime: payload.isDoubleTime ?? false,
          dtMultiplier: payload.dtMultiplier ?? 2,
          notes: payload.notes ?? null,
          attachedFileIds,
        })
      }

      revalidateProjectTimeFinancials(projectId)

      return listProjectTimeEntries(projectId).catch(() => [] as any[])
  })
}

export async function createMyTimeEntryAction(projectId: string, formData: FormData) {
  return run(async () => {
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
        isOvertime: payload.isOvertime ?? false,
        otMultiplier: payload.otMultiplier ?? 1.5,
        isDoubleTime: payload.isDoubleTime ?? false,
        dtMultiplier: payload.dtMultiplier ?? 2,
        notes: payload.notes ?? null,
        attachedFileIds: attachmentId ? [attachmentId] : [],
      })

      revalidateProjectTimeFinancials(projectId)

      return listProjectTimeEntries(projectId).catch(() => [] as any[])
  })
}

export async function listProjectTimeEntriesAction(projectId: string) {
      return listProjectTimeEntries(projectId).catch(() => [] as any[])
}

export async function canManageCrewTimeAction() {
      return hasPermission("time.write")
}

export async function approveTimeEntryFormAction(projectId: string, timeEntryId: string) {
  return run(async () => {
      await approveTimeEntry(timeEntryId)
      revalidateProjectTimeFinancials(projectId)
  })
}

export async function rejectTimeEntryFormAction(projectId: string, timeEntryId: string) {
  return run(async () => {
      await rejectTimeEntry(timeEntryId)
      revalidateProjectTimeFinancials(projectId)
  })
}

export async function createTimeEntryApprovalLinkFormAction(projectId: string, timeEntryId: string) {
  return run(async () => {
      const link = await createTimeEntryApprovalLink(timeEntryId)
      revalidateProjectTimeFinancials(projectId)
      return link
  })
}
