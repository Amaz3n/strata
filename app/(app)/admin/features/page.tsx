import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { FeatureFlagsTable } from "@/components/admin/feature-flags-table"
import { Skeleton } from "@/components/ui/skeleton"
import { getFeatureFlags, getFeatureFlagOrganizations } from "@/lib/services/admin"

export const dynamic = "force-dynamic"

async function FeatureFlagsData() {
  const [featureFlags, organizations] = await Promise.all([
    getFeatureFlags(),
    getFeatureFlagOrganizations(),
  ])

  return <FeatureFlagsTable initialFlags={featureFlags} organizations={organizations} />
}

export default async function FeaturesPage() {
  await requireAnyPermissionGuard(["features.manage", "platform.feature_flags.manage"])

  return (
    <PageLayout
      title="Feature Flags"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Feature Flags" },
      ]}
    >
      <Suspense fallback={<FeatureFlagsSkeleton />}>
        <FeatureFlagsData />
      </Suspense>
    </PageLayout>
  )
}

function FeatureFlagsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}
