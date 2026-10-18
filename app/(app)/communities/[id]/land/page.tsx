import { connection } from "next/server"
import Link from "next/link"
import { notFound } from "next/navigation"

import { CommunityEntitlements } from "@/components/communities/community-entitlements"
import { CommunityRunwayPanel } from "@/components/communities/community-runway-panel"
import { CommunityStructure } from "@/components/communities/community-structure"
import { LandContracts } from "@/components/communities/land-contracts"
import { countLotsByPhase } from "@/lib/services/community-inventory"
import { getCommunityLane } from "@/lib/services/community-portfolio"
import { getCommunity } from "@/lib/services/communities"
import { listCommunityLandContracts } from "@/lib/services/land-contracts"
import { getCommunityDevelopmentLedger } from "@/lib/services/land-development"
import { loadCommunityEntitlementsTab } from "@/lib/services/land-entitlements"
import { getCommunityLandOrigin } from "@/lib/services/land-opportunities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

/** A grant, an org admin, or the wildcard. */
const holdsIn = (granted: string[], key: string) => granted.some((permission) => [key, "org.admin", "*"].includes(permission))

/** The board reads two years so the horizon control is a zoom rather than a refetch. */
const RUNWAY_HORIZON_MONTHS = 24

/**
 * The land manager's tab: how long the lots last, the phases they are released
 * in and the jobs that develop them, the approvals that hold its starts, the
 * contracts that oblige the land, and the takedowns that refill it. These used
 * to sit under Settings, which filed a multi-million-dollar land tranche as a
 * preference.
 */
export default async function CommunityLandPage({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params

  /** Optional panel, logged failure. A blank runway with no trace is not a state. */
  function optional<T>(panel: string, fallback: T) {
    return (error: unknown): T => {
      console.error(`[communities/${id}/land] ${panel} failed to load`, error)
      return fallback
    }
  }

  /** A community this caller cannot reach reads as not found, here as on every panel. */
  function unlessMissing(error: unknown): null {
    if (error instanceof Error && error.message === "Community not found") return null
    throw error
  }

  const permissionsRead = getCurrentUserPermissions()
  const [community, permissions, lane, lotsByPhase, contracts, development, entitlements, origin] = await Promise.all([
    getCommunity(id).catch(unlessMissing),
    permissionsRead,
    // The lane, not the whole portfolio: taking lanes[0] off a portfolio read
    // ran the runway projection for the community twice on one page load.
    getCommunityLane(id).catch(optional("runway", null)),
    countLotsByPhase(id).catch(optional("phase counts", { byPhase: {}, truncated: false })),
    // Contracts carry the deposits every takedown's cash is netted by, so a
    // failure here is the page's error state, not a quietly wrong total.
    listCommunityLandContracts(id).catch(unlessMissing),
    // Development money is for readers of financial reports only.
    permissionsRead.then((granted) =>
      holdsIn(granted.permissions, "report.read")
        ? getCommunityDevelopmentLedger(id).catch(optional("development ledger", null))
        : null,
    ),
    // Entitlements hold starts, so a failure is the page's error state too.
    loadCommunityEntitlementsTab(id).catch(unlessMissing),
    // The deal the land came through: land.read only, and a one-line link.
    getCommunityLandOrigin(id).catch(optional("land origin", [])),
  ])
  const holds = (key: string) => holdsIn(permissions.permissions, key)
  if (!community || !contracts || !entitlements) notFound()

  return (
    <div className="space-y-8 p-4">
      {origin.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Acquired through{" "}
          {origin.map((deal, index) => (
            <span key={deal.id}>
              {index > 0 ? ", " : null}
              <Link href={`/communities/land-deals/${deal.id}`} className="font-medium text-foreground hover:underline">{deal.name}</Link>
            </span>
          ))}
        </p>
      ) : null}
      {lane ? <CommunityRunwayPanel lane={lane} horizonMonths={RUNWAY_HORIZON_MONTHS} /> : null}
      <CommunityStructure
        community={community}
        lotsByPhase={lotsByPhase.byPhase}
        lotsByPhaseTruncated={lotsByPhase.truncated}
        canWrite={holds("community.write")}
        contracts={contracts}
        development={development}
        canLinkDevelopment={holds("community.write") && holds("project.manage")}
        landDeals={origin}
      />
      <CommunityEntitlements tab={entitlements} />
      <LandContracts
        communityId={community.id}
        contracts={contracts}
        takedowns={community.takedowns}
        canWrite={holds("land_contract.write")}
      />
    </div>
  )
}
