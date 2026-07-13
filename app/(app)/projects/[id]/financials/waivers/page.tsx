import { PageLayout } from "@/components/layout/page-layout"
import { listProjectCommitments } from "@/lib/services/commitments"
import { listWaiverMatrixForPayPeriod } from "@/lib/services/lien-waivers"
import { loadFinancialsOverviewData } from "../page-data"
import { WaiverMatrixClient } from "./waiver-matrix-client"

export const dynamic = "force-dynamic"

export default async function WaiversPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ periodEnd?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(query.periodEnd ?? "") ? query.periodEnd! : new Date().toISOString().slice(0, 10)
  const [{ project }, commitments, matrix] = await Promise.all([loadFinancialsOverviewData(id), listProjectCommitments(id), listWaiverMatrixForPayPeriod(id, { end: periodEnd })])
  return <PageLayout title="Lien waivers" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Financials", href: `/projects/${id}/financials` }, { label: "Lien waivers" }]} fullBleed><WaiverMatrixClient projectId={id} periodEnd={periodEnd} commitments={commitments} matrix={matrix} requireSubtierWaivers={project.require_subtier_waivers ?? false} /></PageLayout>
}
