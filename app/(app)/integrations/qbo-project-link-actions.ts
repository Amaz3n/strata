"use server"

import { getProjectAccountingLink, upsertAccountingEntityMap } from "@/lib/services/accounting-target"

export type ProjectQboLink = Awaited<ReturnType<typeof getProjectAccountingLink>>

/** Read an Arc project's linked QBO customer/project (set in the project settings sheet). */
export async function getProjectQboLinkAction(params: { projectId: string }): Promise<ProjectQboLink> {
  return getProjectAccountingLink({ projectId: params.projectId })
}

export async function saveProjectAccountingLinkAction(input: {
  mapId?: string | null
  projectId: string
  connectionId: string
  classId?: string | null
  className?: string | null
  customerId?: string | null
  customerName?: string | null
  acknowledgeResync?: boolean
}) {
  return upsertAccountingEntityMap({
    id: input.mapId ?? undefined,
    projectId: input.projectId,
    connectionId: input.connectionId,
    dimensions: {
      ...(input.classId ? { class: { id: input.classId, name: input.className ?? input.classId } } : {}),
      ...(input.customerId ? { customer: { id: input.customerId, name: input.customerName ?? input.customerId } } : {}),
    },
    acknowledgeResync: input.acknowledgeResync,
  })
}
