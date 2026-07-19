import { listCommunities } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { listDivisions } from "@/lib/services/divisions"
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
  divisions: ProductionScopeOption[]
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

export async function resolveProductionDeskScope(input: {
  communityId?: string
  divisionId?: string
}): Promise<ProductionDeskScope> {
  const context = await requireOrgContext()
  const [communityRows, divisionRows] = await Promise.all([
    listCommunities({}, context.orgId),
    listDivisions(context.orgId),
  ])
  const communities = communityRows.map(({ id, name }) => ({ id, name }))
  const divisions = divisionRows.filter((division) => !division.archived).map(({ id, name }) => ({ id, name }))
  const communityId = communities.some((option) => option.id === input.communityId)
    ? input.communityId
    : undefined
  const divisionId = divisions.some((option) => option.id === input.divisionId)
    ? input.divisionId
    : undefined

  if (!communityId && !divisionId) {
    const invalidRequestedScope = Boolean(input.communityId || input.divisionId)
    return { communities, divisions, communityId, divisionId, projectIds: invalidRequestedScope ? [] : null }
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

  return { communities, divisions, communityId, divisionId, projectIds }
}
