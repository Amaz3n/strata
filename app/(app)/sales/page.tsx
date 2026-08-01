import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { DealBoard } from "@/components/sales/deal-board"
import { NewInquirySheet } from "@/components/sales/new-inquiry-sheet"
import { isDealView, type DealView } from "@/lib/sales/board"
import { isDealFilter, type DealFilter } from "@/lib/sales/next-action"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { listLostReasons, listSalesDeals } from "@/lib/services/sales-deals"
import { listTeamMembers } from "@/lib/services/team"
import { SalesBoardSkeleton } from "./loading"

export const dynamic = "force-dynamic"

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
export default async function SalesPage({ searchParams }: SalesPageProps) {
  const params = await searchParams
  const view: DealView = isDealView(params.view) ? params.view : "open"
  const filter: DealFilter = isDealFilter(params.due) ? params.due : "all"

  return (
    <PageLayout title="Sales">
      <Suspense fallback={<SalesBoardSkeleton />}>
        <SalesBoardBand view={view} filter={filter} />
      </Suspense>
    </PageLayout>
  )
}

async function SalesBoardBand({ view, filter }: { view: DealView; filter: DealFilter }) {
  // Ambient scope is a true dependency of the deal query, so it stays
  // sequential. The team roster is not — it only ever fed the owner lookup, and
  // waiting for the board to land before starting it was a pure waterfall.
  const ambient = await getAmbientDeskContext()
  const [deals, teamMembers] = await Promise.all([
    listSalesDeals({
      divisionId: ambient.divisionId,
      communityId: ambient.communityId,
      includeClosed: view !== "open",
      limit: ROW_CAP,
    }),
    listTeamMembers().catch(() => []),
  ])

  // Lost reasons are keyed off the prospects on the board, so this one genuinely
  // has to follow the deals.
  const lostReasons =
    view === "lost"
      ? await listLostReasons(
          deals.flatMap((deal) => (deal.stage === "lost" && deal.prospectId ? [deal.prospectId] : [])),
        )
      : new Map<string, string>()

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
      truncated={deals.length >= ROW_CAP}
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
