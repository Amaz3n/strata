import { AppShell } from "@/components/layout/app-shell"
import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { getCurrentUserAction } from "@/app/actions/user"
import { listCostCodesAction } from "./actions"

export default async function CostCodesPage() {
  const [user, costCodes] = await Promise.all([getCurrentUserAction(), listCostCodesAction()])

  return (
    <AppShell title="Cost Codes" user={user}>
      <div className="p-4 lg:p-6 space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Cost Codes</h1>
          <p className="text-muted-foreground text-sm">
            Manage your org’s cost code library, seed NAHB defaults, and import CSVs.
          </p>
        </div>
        <CostCodeManager costCodes={costCodes} />
      </div>
    </AppShell>
  )
}
