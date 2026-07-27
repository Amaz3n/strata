import "server-only"

import { cookies } from "next/headers"

import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { listCommunities } from "@/lib/services/communities"
import { listMyCommunityIds } from "@/lib/services/community-assignments"
import { requireOrgContext } from "@/lib/services/context"
import { listDivisions, type DivisionDTO } from "@/lib/services/divisions"

export const DIVISION_CONTEXT_COOKIE = "arc_division_context"
export const COMMUNITY_CONTEXT_COOKIE = "arc_community_context"
/** Written when the user explicitly picks "All communities", so an assignment
 *  default does not silently re-pin the lens on the next request. */
export const COMMUNITY_CONTEXT_ALL = "all"

export interface AmbientCommunity {
  id: string
  name: string
  /** Owning division, or null for a community filed outside one. */
  divisionId: string | null
  /** True when the signed-in user is personally assigned to this community. */
  assigned: boolean
}

export interface AmbientDeskContext {
  divisions: DivisionDTO[]
  divisionId?: string
  /** Communities inside the active division lens — what desks filter and rank by. */
  communities: AmbientCommunity[]
  communityId?: string
  /**
   * Every community the membership may pin, across divisions. The scope switcher
   * needs the whole tree so one click can move both lenses at once.
   */
  pinnableCommunities: AmbientCommunity[]
}

export async function getAmbientDeskContext(): Promise<AmbientDeskContext> {
  const context = await requireOrgContext()
  const [cookieStore, divisions, access] = await Promise.all([
    cookies(),
    listDivisions(context.orgId),
    getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
  ])
  const activeDivisions = divisions.filter((division) =>
    !division.archived && (!access.assignedOnly || access.divisionIds.includes(division.id)),
  )
  const requestedDivisionId = cookieStore.get(DIVISION_CONTEXT_COOKIE)?.value
  const divisionId = activeDivisions.some(({ id }) => id === requestedDivisionId)
    ? requestedDivisionId
    : access.assignedOnly && activeDivisions.length === 1
      ? activeDivisions[0]?.id
      : undefined

  const [communityRows, assignedIds] = await Promise.all([
    listCommunities({}, context.orgId),
    listMyCommunityIds(context.orgId).catch(() => [] as string[]),
  ])
  const assigned = new Set(assignedIds)
  const pinnableCommunities: AmbientCommunity[] = communityRows
    .filter((community) =>
      !access.assignedOnly || (community.divisionId != null && access.divisionIds.includes(community.divisionId)),
    )
    .map((community) => ({
      id: community.id,
      name: community.name,
      divisionId: community.divisionId ?? null,
      assigned: assigned.has(community.id),
    }))
  const communities = divisionId
    ? pinnableCommunities.filter((community) => community.divisionId === divisionId)
    : pinnableCommunities

  const requestedCommunityId = cookieStore.get(COMMUNITY_CONTEXT_COOKIE)?.value
  const assignedInScope = communities.filter((community) => community.assigned)
  const communityId = communities.some(({ id }) => id === requestedCommunityId)
    ? requestedCommunityId
    // Somebody who sits one model home should open Arc already in it. Two or
    // more assignments is ambiguous, so the lens stays open.
    : requestedCommunityId === COMMUNITY_CONTEXT_ALL || assignedInScope.length !== 1
      ? undefined
      : assignedInScope[0]?.id

  return {
    divisions: activeDivisions,
    divisionId,
    communities,
    communityId,
    pinnableCommunities,
  }
}
