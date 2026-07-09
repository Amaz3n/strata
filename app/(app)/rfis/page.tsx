import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { RfisClient } from "@/components/rfis/rfis-client"
import { listRfisAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { listContactsAction } from "@/app/(app)/contacts/actions"
import { Skeleton } from "@/components/ui/skeleton"

import { unwrapAction } from "@/lib/action-result"

// desk-rule: reachable via dashboard/search/feature flows only, not workspace nav.
export const dynamic = 'force-dynamic'

async function RfisData() {
  const [rfis, projects, companies, contacts] = await Promise.all([
    listRfisAction(),
    listProjectsAction(),
    listCompaniesAction(),
    listContactsAction(),
  ])

  return <RfisClient rfis={rfis} projects={projects} companies={companies} contacts={contacts} />
}

export default function RfisPage() {
  return (
    <PageLayout title="RFIs">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <RfisData />
      </Suspense>
    </PageLayout>
  )
}
