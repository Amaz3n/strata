import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { redirect } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { PlatformBugsClient } from "@/components/platform/platform-bugs-client"
import {
  listPlatformBugEvents,
  listPlatformBugAiFixes,
  listPlatformBugAiReviews,
  listPlatformBugContextOptions,
  listPlatformBugOwners,
  listPlatformBugs,
  requirePlatformBugOwner,
} from "@/lib/services/platform-bugs"


async function PlatformBugsPageContent() {
  try {
    await requirePlatformBugOwner()
  } catch {
    redirect("/unauthorized")
  }

  const [bugs, owners, contextOptions] = await Promise.all([
    listPlatformBugs(),
    listPlatformBugOwners(),
    listPlatformBugContextOptions(),
  ])
  const events = await listPlatformBugEvents(bugs.map((bug) => bug.id))
  const aiReviews = await listPlatformBugAiReviews(bugs.map((bug) => bug.id))
  const aiFixes = await listPlatformBugAiFixes(bugs.map((bug) => bug.id))

  return (
    <PageLayout title="Platform Issues">
      <div className="-m-4 -mt-6 h-[calc(100svh-3.5rem)]">
        <PlatformBugsClient
          initialBugs={bugs}
          initialEvents={events}
          initialAiReviews={aiReviews}
          initialAiFixes={aiFixes}
          owners={owners}
          orgs={contextOptions.orgs}
        />
      </div>
    </PageLayout>
  )
}

export default function PlatformBugsPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PlatformBugsPageContent />
    </Suspense>
  )
}
