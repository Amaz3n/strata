import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = "force-dynamic"
import { EstimateTemplatesClient } from "@/components/estimates/estimate-templates-client"
import { listEstimateTemplatesAction } from "./actions"
import { listCostCodesAction } from "../cost-codes/actions"

export default async function EstimateTemplatesPage() {
  const [templates, costCodes] = await Promise.all([listEstimateTemplatesAction(), listCostCodesAction(true)])

  return (
    <PageLayout
      title="Estimate Templates"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Estimate Templates" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Estimate Templates</h1>
          <p className="text-muted-foreground text-sm">
            Reusable sections and line items to start a new estimate from. Terms, cover note, and branding are set in
            Settings → Organization and apply automatically.
          </p>
        </div>
        <EstimateTemplatesClient initialTemplates={templates} costCodes={costCodes} />
      </div>
    </PageLayout>
  )
}
