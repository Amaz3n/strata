import { AppShell } from "@/components/layout/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ProvisionOrgForm } from "@/components/admin/provision-form"
import { getCurrentUserAction } from "@/app/actions/user"
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function ProvisionPage() {
  await requirePermissionGuard("billing.manage")
  const currentUser = await getCurrentUserAction()

  return (
    <AppShell title="Provision Organization" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Provision a new customer org</h1>
          <p className="text-muted-foreground mt-1">
            Create an organization, set billing model, and invite the primary owner. This is restricted to admins with
            billing permissions.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Workspace details</CardTitle>
            <CardDescription>We will create the org, subscription, support contract, and send the invite.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProvisionOrgForm />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}


