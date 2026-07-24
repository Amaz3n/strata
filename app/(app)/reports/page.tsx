import { PageLayout } from "@/components/layout/page-layout"
import { WipOverUnderReportView } from "@/components/reports/wip-over-under-report"
import { getOrgWipOverUnderReport } from "@/lib/services/reports/wip-over-under"
import { Vendor1099ReportView } from "@/components/reports/vendor-1099-report"
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099"
import { ProductionExecutiveReports } from "@/components/reports/production-executive-reports"
import { getOrgProductTier } from "@/lib/services/context"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { getProductionPortfolioReport } from "@/lib/services/production-reporting"
import { getBacklogReport } from "@/lib/services/closings"
import { getCycleTimeReport, getEvenFlowAdherence } from "@/lib/services/even-flow"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const [report, vendor1099, tier, ambient] = await Promise.all([getOrgWipOverUnderReport(), getVendor1099Report(), getOrgProductTier(), getAmbientDeskContext()])
  const today = new Date()
  const from = new Date(today)
  from.setMonth(from.getMonth() - 6)
  const to = new Date(today)
  to.setMonth(to.getMonth() + 3)
  const production = tier === "production"
    ? await Promise.all([
        getProductionPortfolioReport({ divisionId: ambient.divisionId }),
        getBacklogReport({ divisionId: ambient.divisionId }),
        getCycleTimeReport({ groupBy: "community", divisionId: ambient.divisionId, from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) }),
        getEvenFlowAdherence({ divisionId: ambient.divisionId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }),
      ])
    : null

  return (
    <PageLayout title="Reports" fullBleed>
      <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        {production ? <ProductionExecutiveReports report={production[0]} backlog={production[1]} cycle={production[2]} flow={production[3]} /> : null}
        <div>
          <h2 className="text-lg font-semibold">WIP / over-under billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cost-to-cost earned revenue, billed revenue, and over-under position by project.
          </p>
        </div>
        <WipOverUnderReportView report={report} csvHref="/api/reports/wip?format=csv" />
        <Vendor1099ReportView report={vendor1099} />
      </div>
    </PageLayout>
  )
}
