import "server-only"

import { cookies } from "next/headers"

import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { listCommunities } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { listDivisions, type DivisionDTO } from "@/lib/services/divisions"

export const DIVISION_CONTEXT_COOKIE = "arc_division_context"
export const COMMUNITY_CONTEXT_COOKIE = "arc_community_context"

export interface AmbientDeskContext {
  divisions: DivisionDTO[]
  divisionId?: string
  communityId?: string
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

  const communities = (await listCommunities(divisionId ? { divisionId } : {}, context.orgId)).filter((community) =>
    !access.assignedOnly || (community.divisionId != null && access.divisionIds.includes(community.divisionId)),
  )
  const requestedCommunityId = cookieStore.get(COMMUNITY_CONTEXT_COOKIE)?.value
  const communityId = communities.some(({ id }) => id === requestedCommunityId)
    ? requestedCommunityId
    : undefined

  return {
    divisions: activeDivisions,
    divisionId,
    communityId,
  }
}
