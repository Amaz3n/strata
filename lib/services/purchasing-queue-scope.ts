import { z } from "zod"

import { getProjectReadScopeForUser } from "@/lib/services/authorization"
import type { requireOrgContext } from "@/lib/services/context"

export const purchasingQueueFiltersSchema = z.object({
  projectId: z.string().uuid().optional(),
  communityId: z.string().uuid().nullish(),
  divisionId: z.string().uuid().nullish(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
})

export type PurchasingQueueFilters = z.input<typeof purchasingQueueFiltersSchema>

/** Call after the owning service's permission gate. A lens only narrows authority. */
export async function resolvePurchasingQueueReadScope(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  divisionId?: string | null,
) {
  const scope = await getProjectReadScopeForUser(context)
  return {
    ...scope,
    divisionIds: divisionId
      ? scope.divisionIds === null || scope.divisionIds.includes(divisionId) ? [divisionId] : []
      : scope.divisionIds,
  }
}

/** Inner parent predicates keep the root page and exact count in the same scope. */
export function purchasingQueueProjectSelect(
  fields: string,
  scope: Awaited<ReturnType<typeof resolvePurchasingQueueReadScope>>,
  communityId?: string | null,
) {
  const relations = [fields]
  if (communityId) relations.push("lot:lots!lots_project_id_fkey!inner(community_id,community:communities!inner())")
  if (scope.projectMembershipRequired) relations.push("access:project_members!project_members_project_id_fkey!inner()")
  return `project:projects!inner(${relations.filter(Boolean).join(",")})`
}
