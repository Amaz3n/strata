import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { QBOConnectionCard } from "@/components/integrations/qbo-connection-card"
import { getQBOConnection } from "@/lib/services/qbo-connection"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { getCurrentUserAction } from "@/app/actions/user"

export default async function IntegrationsPage() {
  await requirePermissionGuard("org.admin")
  const currentUser = await getCurrentUserAction()
  const qboConnection = await getQBOConnection()

  return (
    <AppShell title="Integrations" user={currentUser}>
      <div className="p-6 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-muted-foreground mt-1">
            Connect your tools to automate workflows
          </p>
        </div>

        <div className="grid gap-6">
          <QBOConnectionCard connection={qboConnection} />
        </div>
      </div>
    </AppShell>
  )
}
