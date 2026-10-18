import { connection } from "next/server"
import { Suspense } from "react"

import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { listMilestoneSources } from "@/lib/services/agreement-milestones"

import { MilestoneFeedsClient } from "./milestone-feeds-client"

const BREADCRUMBS = [{ label: "Settings", href: "/settings" }, { label: "Lender and title feeds" }]

async function MilestoneFeedsContent() {
  await connection()
  const feeds = await listMilestoneSources()
  return (
    <PageLayout fullBleed title="Lender and title feeds" breadcrumbs={BREADCRUMBS}>
      <MilestoneFeedsClient feeds={feeds} />
    </PageLayout>
  )
}

export default function MilestoneFeedsPage() {
  return (
    <Suspense fallback={<PageLayout fullBleed title="Lender and title feeds" breadcrumbs={BREADCRUMBS}><PageLoadingSkeleton /></PageLayout>}>
      <MilestoneFeedsContent />
    </Suspense>
  )
}
