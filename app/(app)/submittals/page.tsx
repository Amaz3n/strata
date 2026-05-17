import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import { listSubmittalsAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

async function SubmittalsData() {
  const [submittals, projects] = await Promise.all([
    listSubmittalsAction(),
    listProjectsAction(),
  ])

  return (
    <div className="space-y-6">
      <SubmittalsClient submittals={submittals} projects={projects} />
    </div>
  )
}

export default function SubmittalsPage() {
  return (
    <PageLayout title="Submittals">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <SubmittalsData />
      </Suspense>
    </PageLayout>
  )
}
