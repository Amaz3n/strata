import { PageLayout } from "@/components/layout/page-layout"
import { GateSettingsClient } from "@/components/starts/gate-settings-client"
import { listGateDefinitions, seedDefaultGateDefinitions } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartSettingsPage() {
  await seedDefaultGateDefinitions()
  const definitions = await listGateDefinitions()
  return <PageLayout title="Start gate settings"><div className="space-y-3 p-4"><p className="max-w-3xl text-sm text-muted-foreground">These definitions control every new start package. Release-produced budget and PO gates are completed by the orchestration ledger.</p><GateSettingsClient definitions={definitions} /></div></PageLayout>
}
