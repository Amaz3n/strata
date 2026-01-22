import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { FeatureFlagsTable } from "@/components/admin/feature-flags-table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

export default async function FeaturesPage() {
  await requirePermissionGuard("features.manage")

  return (
    <PageLayout
      title="Feature Flags"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Feature Flags" }
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Feature Flags</h1>
          <p className="text-muted-foreground mt-2">
            Manage system features and enable/disable functionality per organization
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Feature Management</CardTitle>
            <CardDescription>
              Control which features are enabled for organizations and set feature-specific configurations
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<FeatureFlagsTableSkeleton />}>
              <FeatureFlagsTable />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}

function FeatureFlagsTableSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center space-x-4 p-4 border rounded-lg">
          <Skeleton className="h-6 w-6 rounded" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  )
}