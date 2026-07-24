import { PageLayout } from "@/components/layout/page-layout"
import { GateSettingsClient } from "@/components/starts/gate-settings-client"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listGateDefinitions } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartSettingsPage() {
  const [definitions, permissions] = await Promise.all([listGateDefinitions(), getCurrentUserPermissions()])
  const grants = permissions.permissions
  const canManage = grants.includes("*") || grants.includes("org.admin") || grants.includes("start.release")
  return (
    <PageLayout title="Start gate settings">
      <div className="space-y-3 p-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          These definitions control every new start package. Auto gates are checked by the system; manual gates are attested per package. Release-produced gates (budget, PO set) are completed by the orchestration ledger.
        </p>
        <GateSettingsClient definitions={definitions} canManage={canManage} />
      </div>
    </PageLayout>
  )
}
