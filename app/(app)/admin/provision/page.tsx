import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { ProvisionOrgForm } from "@/components/admin/provision-form"
import { getPlans } from "@/lib/services/admin"

export const dynamic = "force-dynamic"

export default async function ProvisionPage() {
  await requireAnyPermissionGuard(["billing.manage", "platform.billing.manage"])
  const plans = await getPlans()

  return (
    <PageLayout
      title="Provision Organization"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Provision Organization" },
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Provision Organization</h1>
          <p className="text-muted-foreground mt-2">
            Create a new builder org, invite the primary owner, and start a trial.
          </p>
        </div>
        <ProvisionOrgForm plans={plans} />
      </div>
    </PageLayout>
  )
}



