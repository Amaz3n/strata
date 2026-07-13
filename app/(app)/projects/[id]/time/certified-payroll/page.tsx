import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import {
  getCertifiedPayrollReport,
  listCertifiedPayrollReports,
  listPayrollWorkerProfiles,
  listWageClassifications,
  listWageDeterminations,
} from "@/lib/services/certified-payroll"
import { CertifiedPayrollClient } from "./certified-payroll-client"

export const dynamic = "force-dynamic"

export default async function CertifiedPayrollPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ report?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const project = await getProjectAction(id)
  if (!project) notFound()
  if (!project.is_public_work) {
    return (
      <PageLayout title="Certified payroll" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Time", href: `/projects/${id}/time` }, { label: "Certified payroll" }]}>
        <div className="border px-6 py-16 text-center"><h2 className="text-sm font-semibold">Prevailing wage is not enabled</h2><p className="mt-2 text-xs text-muted-foreground">Turn on Public work / prevailing wage in project settings to configure wage rates and certified payroll.</p></div>
      </PageLayout>
    )
  }
  const [determinations, classifications, workers, reports] = await Promise.all([
    listWageDeterminations(id), listWageClassifications(id), listPayrollWorkerProfiles(), listCertifiedPayrollReports(id),
  ])
  const selectedReportId = query.report && reports.some((report) => report.id === query.report) ? query.report : reports[0]?.id
  const selected = selectedReportId ? await getCertifiedPayrollReport(selectedReportId) : null
  return (
    <PageLayout title="Certified payroll" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Time", href: `/projects/${id}/time` }, { label: "Certified payroll" }]} fullBleed>
      <CertifiedPayrollClient projectId={id} determinations={determinations} classifications={classifications} workers={workers} reports={reports} initialSelected={selected} />
    </PageLayout>
  )
}
