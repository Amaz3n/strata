import { PageLayout } from "@/components/layout/page-layout"
import { WipOverUnderReportView } from "@/components/reports/wip-over-under-report"
import { getOrgWipOverUnderReport } from "@/lib/services/reports/wip-over-under"
import { Vendor1099ReportView } from "@/components/reports/vendor-1099-report"
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099"

export const dynamic = "force-dynamic"

export default async function ReportsPage() {
  const [report, vendor1099] = await Promise.all([getOrgWipOverUnderReport(), getVendor1099Report()])

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
        <Vendor1099ReportView report={vendor1099} />
      </div>
    </PageLayout>
  )
}
