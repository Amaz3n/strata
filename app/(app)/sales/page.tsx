import { Suspense } from "react"
import { connection } from "next/server"

import { PageLayout } from "@/components/layout/page-layout"
import { DealBoard } from "@/components/sales/deal-board"
import { NewInquirySheet } from "@/components/sales/new-inquiry-sheet"
import { SalesBoardSkeleton } from "@/components/sales/deal-board-skeleton"
import { LeadIntakeBand, LeadIntakeBandError, LeadIntakeBandSkeleton } from "@/components/sales/lead-intake-band"
import { SpecApprovalsStrip, SpecApprovalsStripError, SpecApprovalsStripSkeleton } from "@/components/sales/spec-approvals-strip"
import { isDealView, type DealView } from "@/lib/sales/board"
import { isDealFilter, type DealFilter } from "@/lib/sales/next-action"
import { shouldShowCustomBuildNavigation } from "@/lib/product-tier"
import { getOrgProductTier } from "@/lib/services/context"
import { readMilestoneDeskSignals } from "@/lib/services/agreement-milestones"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { listLeadAttention } from "@/lib/services/lead-intake"
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope"
import { listLostReasons, listSalesBoard } from "@/lib/services/sales-deals"
import { listSpecApprovals } from "@/lib/services/spec-dispositions"
import { listTeamMembers } from "@/lib/services/team"


/** 400-lot communities are the design case; the board never streams unbounded. */
const ROW_CAP = 500

interface SalesPageProps {
  searchParams: Promise<{ due?: string; view?: string }>
}

/**
 * The sales consultant's desk. Community scope comes from the header lens, not a
 * filter on this page — production staff are assigned to communities, so the
 * scope is ambient across every desk at once.
 */
async function SalesPageContent({ searchParams }: SalesPageProps) {
  const params = await searchParams
  const view: DealView = isDealView(params.view) ? params.view : "open"
  const filter: DealFilter = isDealFilter(params.due) ? params.due : "all"

  return (
    <PageLayout title="Sales">
      <div className="space-y-3">
        <Suspense fallback={<LeadIntakeBandSkeleton />}>
          <SalesLeadIntakeBand />
        </Suspense>
        <Suspense fallback={<SpecApprovalsStripSkeleton />}>
          <SpecApprovalsBand />
        </Suspense>
        <Suspense fallback={<SalesBoardSkeleton />}>
          <SalesBoardBand view={view} filter={filter} />
        </Suspense>
      </div>
    </PageLayout>
  )
}

/**
 * Spec price changes and sell-offs waiting on someone, in the desk's ambient
 * scope. Decisions are made with the community workbench's actions.
 */
async function SpecApprovalsBand() {
  await connection()
  const approvals = await getAmbientDeskContext()
    .then((ambient) => listSpecApprovals({ divisionId: ambient.divisionId, communityId: ambient.communityId }))
    .catch(() => null)
  if (!approvals) return <SpecApprovalsStripError />
  return <SpecApprovalsStrip items={approvals.items} truncated={approvals.truncated} />
}

/**
 * Website leads that did not file, are still retrying, or have no owner, in the
 * desk's ambient scope. Leads with no community belong to the Pipeline on an org
 * that also builds custom homes.
 */
async function SalesLeadIntakeBand() {
  await connection()
  const loaded = await Promise.all([getAmbientDeskContext(), getOrgProductTier(), orgHasActiveNonProductionProjects()])
    .then(async ([ambient, tier, hasCustomWork]) => {
      const attention = await listLeadAttention({
        desk: "sales",
        customBuildNavigation: shouldShowCustomBuildNavigation(tier, hasCustomWork),
        communityIds: ambient.communityId
          ? [ambient.communityId]
          : ambient.divisionId
            ? ambient.communities.map((community) => community.id)
            : null,
      })
      // Filing a failed delivery by hand opens the registration card, which needs its pickers.
      const teamMembers = attention.canAct && attention.counts.failed > 0
        ? await listTeamMembers(undefined, { includeProjectCounts: false })
        : []
      return { ambient, attention, teamMembers }
    })
    .catch(() => null)
  if (!loaded) return <LeadIntakeBandError />
  const { ambient, attention, teamMembers } = loaded
  return (
    <LeadIntakeBand
      attention={attention}
      registration={attention.canAct ? {
        communities: ambient.communities.map(({ id, name }) => ({ id, name })),
        teamMembers: teamMembers.map((member) => ({ id: member.user.id, name: member.user.full_name })),
      } : undefined}
    />
  )
}

async function SalesBoardBand({ view, filter }: { view: DealView; filter: DealFilter }) {
  await connection()
  const boardPromise = getAmbientDeskContext().then(async (ambient) => {
    const { deals, truncated } = await listSalesBoard({
      divisionId: ambient.divisionId,
      communityId: ambient.communityId,
      includeClosed: view !== "open",
      limit: ROW_CAP,
    })
    const soldHomeIds = deals.flatMap((deal) =>
      deal.projectId && (deal.stage === "contract" || deal.stage === "building" || deal.stage === "closing") ? [deal.projectId] : [])
    const [lostReasons, milestones] = await Promise.all([
      view === "lost"
        ? listLostReasons(deals.flatMap((deal) => (deal.stage === "lost" && deal.prospectId ? [deal.prospectId] : [])))
        : new Map<string, string>(),
      // The board still opens when the milestone read fails; it says so instead of ranking without them.
      readMilestoneDeskSignals(soldHomeIds).catch(() => null),
    ])
    return { ambient, deals, truncated, lostReasons, milestones }
  })
  const [{ ambient, deals, truncated, lostReasons, milestones }, teamMembers] = await Promise.all([
    boardPromise,
    listTeamMembers(undefined, { includeProjectCounts: false }).catch(() => []),
  ])

  const communityOptions = ambient.communities.map(({ id, name }) => ({ id, name }))
  const owners = Object.fromEntries(teamMembers.map((member) => [member.user.id, member.user.full_name]))

  return (
    <DealBoard
      deals={deals}
      view={view}
      filter={filter}
      owners={owners}
      lostReasons={Object.fromEntries(lostReasons)}
      communities={communityOptions}
      truncated={truncated}
      milestones={milestones}
      now={new Date()}
      actions={
        <NewInquirySheet
          communities={communityOptions}
          teamMembers={teamMembers.map((member) => ({ id: member.user.id, name: member.user.full_name }))}
          defaultCommunityId={ambient.communityId}
        />
      }
    />
  )
}

export default function SalesPage(props: Parameters<typeof SalesPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Sales"><SalesBoardSkeleton /></PageLayout>}>
      <SalesPageContent {...props} />
    </Suspense>
  )
}
