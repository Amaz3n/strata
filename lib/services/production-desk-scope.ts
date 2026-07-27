import { listCommunities } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import {
  getCommunityProjectIds,
  getDivisionProjectIds,
  getReportingExcludedProjectIds,
} from "@/lib/services/reporting-scope"

export interface ProductionScopeOption {
  id: string
  name: string
}

export interface ProductionDeskScope {
  communities: ProductionScopeOption[]
  communityId?: string
  divisionId?: string
  /** null means no filter; [] deliberately matches no projects. */
  projectIds: string[] | null
}

export async function orgHasProductionProjects(orgId?: string): Promise<boolean> {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase
    .from("projects")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("property_type", "production")
    .limit(1)
  if (error) throw new Error(`Failed to inspect production projects: ${error.message}`)
  return (data ?? []).length > 0
}

export async function orgHasActiveNonProductionProjects(orgId?: string): Promise<boolean> {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase
    .from("projects")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("status", "active")
    .or("property_type.is.null,property_type.neq.production")
    .limit(1)
  if (error) throw new Error(`Failed to inspect mixed-posture projects: ${error.message}`)
  return (data ?? []).length > 0
}

export async function resolveProductionDeskScope(input: {
  communityId?: string
}): Promise<ProductionDeskScope> {
  const context = await requireOrgContext()
  const ambient = await getAmbientDeskContext()
  const requestedCommunityId = input.communityId ?? ambient.communityId
  const communityRows = await listCommunities({}, context.orgId)
  const communities = communityRows.map(({ id, name }) => ({ id, name }))
  const communityId = communities.some((option) => option.id === requestedCommunityId)
    ? requestedCommunityId
    : undefined
  const divisionId = ambient.divisionId

  if (!communityId && !divisionId) {
    return { communities, communityId, divisionId, projectIds: requestedCommunityId ? [] : null }
  }

  const [communityProjectIds, divisionProjectIds, excludedProjectIds] = await Promise.all([
    communityId ? getCommunityProjectIds(context.supabase, context.orgId, communityId) : null,
    divisionId ? getDivisionProjectIds(context.supabase, context.orgId, divisionId) : null,
    getReportingExcludedProjectIds(context.supabase, context.orgId),
  ])
  const divisionProjectSet = divisionProjectIds ? new Set(divisionProjectIds) : null
  const excludedProjectSet = new Set(excludedProjectIds)
  const projectIds = communityProjectIds && divisionProjectIds
    ? communityProjectIds.filter((id) => divisionProjectSet?.has(id) && !excludedProjectSet.has(id))
    : (communityProjectIds ?? divisionProjectIds ?? [])
        .filter((id) => !excludedProjectSet.has(id))

  return { communities, communityId, divisionId, projectIds }
}
