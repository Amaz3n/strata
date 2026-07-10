import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { Skeleton } from "@/components/ui/skeleton"
import { OpsClient } from "@/components/admin/ops-client"
import { getCronHealth, getOutboxHealth, getQboConnectionHealth } from "@/lib/services/ops"

export const dynamic = "force-dynamic"

async function OpsData() {
  const [cronHealth, outboxHealth, qboHealth] = await Promise.all([
    getCronHealth(),
    getOutboxHealth(),
    getQboConnectionHealth(),
  ])

  return <OpsClient cronHealth={cronHealth} outboxHealth={outboxHealth} qboHealth={qboHealth} />
}

export default async function OpsPage() {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])

  return (
    <PageLayout
      title="Ops"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Ops" },
      ]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<OpsSkeleton />}>
          <OpsData />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function OpsSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-card px-4 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-10" />
          </div>
        ))}
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}
