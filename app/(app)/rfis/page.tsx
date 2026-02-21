import { PageLayout } from "@/components/layout/page-layout"
import { RfisClient } from "@/components/rfis/rfis-client"
import { listRfisAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { listContactsAction } from "@/app/(app)/contacts/actions"

export const dynamic = 'force-dynamic'

export default async function RfisPage() {
  const [rfis, projects, companies, contacts] = await Promise.all([
    listRfisAction(),
    listProjectsAction(),
    listCompaniesAction(),
    listContactsAction(),
  ])

  return (
    <PageLayout title="RFIs">
      <div className="space-y-6">
        <RfisClient rfis={rfis} projects={projects} companies={companies} contacts={contacts} />
      </div>
    </PageLayout>
  )
}
