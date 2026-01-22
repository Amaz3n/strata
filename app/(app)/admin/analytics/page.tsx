import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { SystemMetrics } from "@/components/admin/system-metrics"
import { UsageCharts } from "@/components/admin/usage-charts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

export default async function AnalyticsPage() {
  await requirePermissionGuard("billing.manage")

  return (
    <PageLayout
      title="System Analytics"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "System Analytics" }
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">System Analytics</h1>
          <p className="text-muted-foreground mt-2">
            Monitor system performance, usage patterns, and business metrics
          </p>
        </div>

        <Suspense fallback={<SystemMetricsSkeleton />}>
          <SystemMetrics />
        </Suspense>

        <Suspense fallback={<Skeleton className="h-96" />}>
          <UsageCharts />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function SystemMetricsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-12" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}