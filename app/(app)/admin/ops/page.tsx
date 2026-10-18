import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { Skeleton } from "@/components/ui/skeleton"
import { OpsClient } from "@/components/admin/ops-client"
import {
  getCronHealth,
  getOutboxBacklogByOrg,
  getOutboxHealth,
  getQboConnectionHealth,
  listOperationsAlerts,
  listStuckOutboxJobs,
} from "@/lib/services/ops"
import {
  listOpenPaymentReconciliationExceptions,
  listPaymentReconciliations,
} from "@/lib/services/payment-reconciliation"


async function OpsData() {
  // Reconciliation needs `payment.reconcile`, which an ops viewer may not hold —
  // it settles beside cron and outbox health because it is the same kind of thing
  // (a daily job whose silence is the alarm), not because everyone here can read it.
  const [cronHealth, outboxHealth, orgBacklog, stuckHealth, qboHealth, reconciliations, exceptions, operationsAlerts] = await Promise.all([
    getCronHealth(),
    getOutboxHealth(),
    getOutboxBacklogByOrg(),
    listStuckOutboxJobs(),
    getQboConnectionHealth(),
    listPaymentReconciliations().catch(() => []),
    listOpenPaymentReconciliationExceptions().catch(() => []),
    listOperationsAlerts(),
  ])

  return (
    <OpsClient
      referenceTimeMs={Date.now()}
      cronHealth={cronHealth}
      outboxHealth={outboxHealth}
      orgBacklog={orgBacklog}
      stuckHealth={stuckHealth}
      qboHealth={qboHealth}
      reconciliations={reconciliations}
      reconciliationExceptions={exceptions}
      operationsAlerts={operationsAlerts}
    />
  )
}

async function OpsPageContent() {
  await connection()
  await requireAnyPermissionGuard(["platform.support.read"])

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
      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
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

export default function OpsPage() {
  return (
    <Suspense fallback={
      <PageLayout
      title="Ops"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Ops" },
      ]}
    >
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <OpsPageContent />
    </Suspense>
  )
}
