import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { PageLayout } from "@/components/layout/page-layout"
import { ReconciliationReportView } from "@/components/reports/reconciliation-report"
import { getProjectReconciliationReport } from "@/lib/services/reports/reconciliation"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectReconciliationReportPage({ params }: PageProps) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const report = await getProjectReconciliationReport(project.id)

  return (
    <PageLayout
      title="Financial Reconciliation"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Reports", href: `/projects/${project.id}/reports` },
        { label: "Reconciliation" },
      ]}
      fullBleed
    >
      <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">
          Integrity checks across invoices, the billable ledger, job costs, payments, and retainage. Every exception
          links to the page where it can be fixed.
        </p>
        <ReconciliationReportView report={report} />
      </div>
    </PageLayout>
  )
}
