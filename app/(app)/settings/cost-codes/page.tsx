import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { listCostCodesAction } from "./actions"

export default async function CostCodesPage() {
  const costCodes = await listCostCodesAction(true)

  return (
    <PageLayout
      title="Cost Codes"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Cost Codes" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Cost Codes</h1>
          <p className="text-muted-foreground text-sm">
            Manage your org’s cost code library, seed NAHB defaults, and import CSVs.
          </p>
        </div>
        <CostCodeManager costCodes={costCodes} />
      </div>
    </PageLayout>
  )
}



