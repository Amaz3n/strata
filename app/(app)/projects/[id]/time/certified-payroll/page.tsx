import { connection } from "next/server"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
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


type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ report?: string }> }

export default function CertifiedPayrollPage(props: Props) {
  return (
    <Suspense fallback={
      <PageLayout title="Certified payroll" fullBleed>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <CertifiedPayrollData {...props} />
    </Suspense>
  )
}

async function CertifiedPayrollData({ params, searchParams }: Props) {
  await connection()
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
  const reportsPromise = listCertifiedPayrollReports(id)
  const selectedPromise = reportsPromise.then(async (reports) => {
    const selectedReportId = query.report && reports.some((report) => report.id === query.report) ? query.report : reports[0]?.id
    return { selectedReportId, selected: selectedReportId ? await getCertifiedPayrollReport(selectedReportId) : null }
  })
  const [determinations, classifications, workers, reports, { selectedReportId, selected }] = await Promise.all([
    listWageDeterminations(id), listWageClassifications(id), listPayrollWorkerProfiles(), reportsPromise, selectedPromise,
  ])
  return (
    <PageLayout title="Certified payroll" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Time", href: `/projects/${id}/time` }, { label: "Certified payroll" }]} fullBleed>
      <CertifiedPayrollClient key={`${id}:${selectedReportId ?? "none"}`} projectId={id} determinations={determinations} classifications={classifications} workers={workers} reports={reports} initialSelected={selected} />
    </PageLayout>
  )
}
