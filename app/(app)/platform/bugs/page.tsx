import { connection } from "next/server"
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
  await connection()
  try {
    await requirePlatformBugOwner()
  } catch {
    redirect("/unauthorized")
  }

  const bugsPromise = listPlatformBugs()
  const historyPromise = bugsPromise.then((bugs) => {
    const bugIds = bugs.map((bug) => bug.id)
    return Promise.all([
      listPlatformBugEvents(bugIds),
      listPlatformBugAiReviews(bugIds),
      listPlatformBugAiFixes(bugIds),
    ] as const)
  })
  const [bugs, owners, contextOptions, [events, aiReviews, aiFixes]] = await Promise.all([
    bugsPromise,
    listPlatformBugOwners(),
    listPlatformBugContextOptions(),
    historyPromise,
  ])

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
    <Suspense
      fallback={
        <PageLayout title="Platform Issues">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <PlatformBugsPageContent />
    </Suspense>
  )
}
