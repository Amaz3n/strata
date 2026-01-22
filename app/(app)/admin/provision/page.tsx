import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { ProvisionOrgForm } from "@/components/admin/provision-form"

export const dynamic = "force-dynamic"

export default async function ProvisionPage() {
  await requirePermissionGuard("billing.manage")

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
        <ProvisionOrgForm />
      </div>
    </PageLayout>
  )
}






