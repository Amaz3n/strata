import { AdminLoadingSkeleton } from "@/components/admin/admin-loading-skeleton"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { Skeleton } from "@/components/ui/skeleton"
import { DrawingsDeadLetterClient } from "@/components/admin/drawings-deadletter-client"
import { listFailedDrawingsPipelineJobs } from "@/lib/services/ops"


async function DeadLetterData() {
  const health = await listFailedDrawingsPipelineJobs()
  return <DrawingsDeadLetterClient health={health} />
}

async function DrawingsDeadLetterPageContent() {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])

  return (
    <PageLayout
      title="Drawings pipeline"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Ops", href: "/admin/ops" },
        { label: "Drawings pipeline" },
      ]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<DeadLetterSkeleton />}>
          <DeadLetterData />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function DeadLetterSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}

export default function DrawingsDeadLetterPage() {
  return (
    <Suspense fallback={<AdminLoadingSkeleton />}>
      <DrawingsDeadLetterPageContent />
    </Suspense>
  )
}
