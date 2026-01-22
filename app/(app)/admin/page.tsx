import { Suspense } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { AdminStats } from "@/components/admin/admin-stats"
import { QuickActions } from "@/components/admin/quick-actions"
import { RecentActivity } from "@/components/admin/recent-activity"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

export default async function AdminDashboard() {
  // Require billing.manage permission for admin access
  await requirePermissionGuard("billing.manage")

  return (
    <PageLayout
      title="Admin Dashboard"
      breadcrumbs={[
        { label: "Admin" }
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">System Administration</h1>
          <p className="text-muted-foreground mt-2">
            Manage customers, subscriptions, and system settings
          </p>
        </div>

        <Suspense fallback={<AdminStatsSkeleton />}>
          <AdminStats />
        </Suspense>

        <div className="grid gap-6 md:grid-cols-2">
          <Suspense fallback={<Skeleton className="h-80" />}>
            <QuickActions />
          </Suspense>

          <Suspense fallback={<Skeleton className="h-80" />}>
            <RecentActivity />
          </Suspense>
        </div>

      </div>
    </PageLayout>
  )
}

function AdminStatsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
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