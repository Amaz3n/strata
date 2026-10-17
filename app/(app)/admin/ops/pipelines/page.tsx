import { connection } from "next/server"
import { Suspense } from "react"

import { PipelineFailuresClient } from "@/components/admin/pipeline-failures-client"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { listPipelineFailures } from "@/lib/services/pipeline-failures"

const BREADCRUMBS = [
  { label: "Admin", href: "/admin" },
  { label: "Ops", href: "/admin/ops" },
  { label: "Production work" },
]

async function PipelineFailuresData() {
  await connection()
  await requireAnyPermissionGuard(["platform.support.read"])
  const groups = await listPipelineFailures()
  return <PipelineFailuresClient groups={groups} />
}

function PipelineFailuresSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-8 w-24" />
      </div>
      {Array.from({ length: 3 }).map((_, group) => (
        <div key={group} className="border-b">
          <div className="flex items-center gap-3 bg-muted/30 px-4 py-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-10" /></div>
          <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, row) => <Skeleton key={row} className="h-10 w-full" />)}</div>
        </div>
      ))}
    </div>
  )
}

export default function PipelineFailuresPage() {
  return (
    <PageLayout title="Production work" breadcrumbs={BREADCRUMBS}>
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<PipelineFailuresSkeleton />}>
          <PipelineFailuresData />
        </Suspense>
      </div>
    </PageLayout>
  )
}
