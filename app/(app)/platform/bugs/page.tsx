import { redirect } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { PlatformBugsClient } from "@/components/platform/platform-bugs-client"
import {
  listPlatformBugEvents,
  listPlatformBugAiReviews,
  listPlatformBugContextOptions,
  listPlatformBugOwners,
  listPlatformBugs,
  requirePlatformBugOwner,
} from "@/lib/services/platform-bugs"

export const dynamic = "force-dynamic"

export default async function PlatformBugsPage() {
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

  return (
    <PageLayout title="Platform Issues">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <PlatformBugsClient
          initialBugs={bugs}
          initialEvents={events}
          initialAiReviews={aiReviews}
          owners={owners}
          orgs={contextOptions.orgs}
        />
      </div>
    </PageLayout>
  )
}
