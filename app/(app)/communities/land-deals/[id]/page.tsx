import { notFound } from "next/navigation"
import { connection } from "next/server"
import { Suspense } from "react"

import { LandDealSkeleton } from "@/components/land/land-deal-skeleton"
import { LandDealWorkbench } from "@/components/land/land-deal-workbench"
import { PageLayout } from "@/components/layout/page-layout"
import { listCommunities } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getLandOpportunity, listLandPickerOptions } from "@/lib/services/land-opportunities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { hasApprovedAcquisition } from "@/lib/land/diligence"

const BREADCRUMBS = [
  { label: "Communities", href: "/communities" },
  { label: "Land deals", href: "/communities/land-deals" },
]

async function LandDealData({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  const [deal, permissionResult, pickers] = await Promise.all([
    getLandOpportunity(id).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Land deal not found") return null
      throw error
    }),
    getCurrentUserPermissions(),
    listLandPickerOptions(),
  ])
  if (!deal) notFound()

  const permissions = permissionResult.permissions
  const holds = (key: string) => permissions.includes(key) || permissions.includes("*")
  const canWrite = holds("land.write")
  const canCreateCommunity = canWrite && holds("community.write")
  const linking = canCreateCommunity && !deal.communityId && hasApprovedAcquisition(deal.reviews)
  const [divisions, communities] = await Promise.all([
    canWrite ? listDivisions() : Promise.resolve([]),
    linking ? listCommunities() : Promise.resolve([]),
  ])

  return (
    <PageLayout title={deal.name} breadcrumbs={[...BREADCRUMBS, { label: deal.name }]} fullBleed>
      <LandDealWorkbench
        deal={deal}
        viewerId={permissionResult.userId}
        canWrite={canWrite}
        canCreateCommunity={canCreateCommunity}
        people={pickers.people}
        companies={pickers.companies}
        divisions={divisions.filter((division) => !division.archived).map((division) => ({ id: division.id, name: division.name }))}
        communities={communities.map((community) => ({ id: community.id, name: community.name }))}
        today={new Date().toISOString().slice(0, 10)}
      />
    </PageLayout>
  )
}

export default function LandDealPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Land deal" breadcrumbs={[...BREADCRUMBS, { label: "Land deal" }]} fullBleed>
          <LandDealSkeleton />
        </PageLayout>
      }
    >
      <LandDealData params={props.params} />
    </Suspense>
  )
}
