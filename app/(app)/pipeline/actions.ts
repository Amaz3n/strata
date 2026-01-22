"use server"

import { revalidatePath } from "next/cache"
import {
  listProspects,
  getProspect,
  createProspect,
  updateProspect,
  changeLeadStatus,
  setFollowUp,
  addTouch,
  getProspectActivity,
  getCrmDashboardStats,
  trackInCrm,
  getRecentActivity,
} from "@/lib/services/crm"
import {
  createProspectInputSchema,
  updateProspectInputSchema,
  changeStatusInputSchema,
  setFollowUpInputSchema,
  addTouchInputSchema,
  prospectFiltersSchema,
} from "@/lib/validation/crm"

function revalidatePipelinePaths(contactId?: string) {
  revalidatePath("/pipeline")
  revalidatePath("/prospects")
  revalidatePath("/directory")
  revalidatePath("/contacts")
  if (contactId) {
    revalidatePath(`/prospects/${contactId}`)
  }
}

export async function listProspectsAction(filters?: unknown) {
  const parsed = prospectFiltersSchema.parse(filters ?? undefined)
  return listProspects(undefined, parsed)
}

export async function getProspectAction(contactId: string) {
  return getProspect(contactId)
}

export async function createProspectAction(input: unknown) {
  const parsed = createProspectInputSchema.parse(input)
  const prospect = await createProspect({ input: parsed })
  revalidatePipelinePaths(prospect.id)
  return prospect
}

export async function updateProspectAction(contactId: string, input: unknown) {
  const parsed = updateProspectInputSchema.parse(input)
  const prospect = await updateProspect({ contactId, input: parsed })
  revalidatePipelinePaths(contactId)
  return prospect
}

export async function changeLeadStatusAction(input: unknown) {
  const parsed = changeStatusInputSchema.parse(input)
  const prospect = await changeLeadStatus({ input: parsed })
  revalidatePipelinePaths(parsed.contact_id)
  return prospect
}

export async function setFollowUpAction(input: unknown) {
  const parsed = setFollowUpInputSchema.parse(input)
  const prospect = await setFollowUp({ input: parsed })
  revalidatePipelinePaths(parsed.contact_id)
  return prospect
}

export async function addTouchAction(input: unknown) {
  const parsed = addTouchInputSchema.parse(input)
  await addTouch({ input: parsed })
  revalidatePipelinePaths(parsed.contact_id)
}

export async function getProspectActivityAction(contactId: string, limit?: number) {
  return getProspectActivity(contactId, undefined, limit)
}

export async function getCrmDashboardStatsAction() {
  return getCrmDashboardStats()
}

export async function trackInCrmAction(contactId: string) {
  const prospect = await trackInCrm({ contactId })
  revalidatePipelinePaths(contactId)
  return prospect
}

export async function getRecentActivityAction(limit?: number) {
  return getRecentActivity(undefined, limit)
}
