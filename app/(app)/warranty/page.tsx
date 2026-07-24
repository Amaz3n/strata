import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { listCompanies } from "@/lib/services/companies"
import { getWarrantyCostSummary, getWarrantyDefectAnalysis, listWarrantyBackcharges, listWarrantyRequestsForOrg, listWarrantyTechnicians, listWarrantyVisitsForDispatch } from "@/lib/services/warranty"
import { WarrantyDeskClient } from "./warranty-desk-client"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

export default function WarrantyDeskPage() {
  return <PageLayout title="Warranty & service" breadcrumbs={[{ label: "Warranty" }]}><Suspense fallback={<div className="space-y-3">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>}><WarrantyDeskData /></Suspense></PageLayout>
}

async function WarrantyDeskData() {
  const ambient = await getAmbientDeskContext()
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay())
  const end = new Date(start.getTime() + 7 * 86_400_000)
  const [requests, visits, backcharges, defects, costs, technicians, companies] = await Promise.all([
    listWarrantyRequestsForOrg({ status: ["open","in_progress"], pageSize: 100, communityId: ambient.communityId, divisionId: ambient.divisionId }),
    listWarrantyVisitsForDispatch({ from: start.toISOString(), to: end.toISOString(), divisionId: ambient.divisionId }),
    listWarrantyBackcharges({ pageSize: 100, divisionId: ambient.divisionId }),
    getWarrantyDefectAnalysis({ groupBy: "community", divisionId: ambient.divisionId }),
    getWarrantyCostSummary({ communityId: ambient.communityId, divisionId: ambient.divisionId }),
    listWarrantyTechnicians(),
    listCompanies(),
  ])
  return <WarrantyDeskClient requests={requests.rows} total={requests.total} visits={visits} backcharges={backcharges.rows} defects={defects} costs={costs} technicians={technicians} companies={companies.map((company) => ({ id: company.id, name: company.name }))} />
}
