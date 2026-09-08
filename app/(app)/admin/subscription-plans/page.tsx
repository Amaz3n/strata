import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { SubscriptionPlansClient } from "@/components/admin/subscription-plans-client"
import { getPlans } from "@/lib/services/admin"


async function PlansPageContent() {
  await requireAnyPermissionGuard(["billing.manage", "platform.billing.manage"])

  const plans = await getPlans()

  return (
    <PageLayout
      title="Subscription Plans"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Subscription Plans" }
      ]}
    >
      <div className="space-y-6">
        <SubscriptionPlansClient plans={plans} />
      </div>
    </PageLayout>
  )
}

export default function PlansPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PlansPageContent />
    </Suspense>
  )
}
