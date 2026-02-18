import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { PlansClient } from "@/components/admin/plans-client"
import { getPlans } from "@/lib/services/admin"

export const dynamic = 'force-dynamic'

export default async function PlansPage() {
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
        <PlansClient plans={plans} />
      </div>
    </PageLayout>
  )
}
