import { PageLayout } from "@/components/layout/page-layout"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"

import { PayablesDesk } from "./payables-desk"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ community?: string; division?: string }> }) {
  const params = await searchParams
  const scope = await resolveProductionDeskScope({ communityId: params.community, divisionId: params.division })
  const data = await loadOrgPayablesDesk(scope.projectIds)

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} divisions={scope.divisions} communityId={scope.communityId} divisionId={scope.divisionId} className="border-b px-4 py-2.5 sm:px-6" />
      <PayablesDesk data={data} />
    </PageLayout>
  )
}
