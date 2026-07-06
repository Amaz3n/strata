import { PageLayout } from "@/components/layout/page-layout"
import { WipOverUnderReportView } from "@/components/reports/wip-over-under-report"
import { getOrgWipOverUnderReport } from "@/lib/services/reports/wip-over-under"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const report = await getOrgWipOverUnderReport()

  return (
    <PageLayout title="Reports" fullBleed>
      <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <div>
          <h2 className="text-lg font-semibold">WIP / over-under billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cost-to-cost earned revenue, billed revenue, and over-under position by project.
          </p>
        </div>
        <WipOverUnderReportView report={report} csvHref="/api/reports/wip?format=csv" />
      </div>
    </PageLayout>
  )
}
