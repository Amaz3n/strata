import { notFound } from "next/navigation"

import { CommunityRunwayPanel } from "@/components/communities/community-runway-panel"
import { CommunityStructure } from "@/components/communities/community-structure"
import { countLotsByPhase } from "@/lib/services/community-inventory"
import { getCommunityLane } from "@/lib/services/community-portfolio"
import { getCommunity } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

/** The board reads two years so the horizon control is a zoom rather than a refetch. */
const RUNWAY_HORIZON_MONTHS = 24

/**
 * The land manager's tab: how long the lots last, the phases they are released
 * in, and the takedowns that refill them. These used to sit under Settings,
 * which filed a multi-million-dollar land tranche as a preference.
 */
export default async function CommunityLandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, permissions, lane, lotsByPhase] = await Promise.all([
    getCommunity(id).catch(() => null),
    getCurrentUserPermissions(),
    // The lane, not the whole portfolio: taking lanes[0] off a portfolio read
    // ran the runway projection for the community twice on one page load.
    getCommunityLane(id).catch(() => null),
    countLotsByPhase(id).catch(() => ({})),
  ])
  if (!community) notFound()

  const canWrite = permissions.permissions.some((permission) =>
    ["community.write", "org.admin", "*"].includes(permission),
  )

  return (
    <div className="space-y-8 p-4">
      {lane ? <CommunityRunwayPanel lane={lane} horizonMonths={RUNWAY_HORIZON_MONTHS} /> : null}
      <CommunityStructure community={community} lotsByPhase={lotsByPhase} canWrite={canWrite} />
    </div>
  )
}
