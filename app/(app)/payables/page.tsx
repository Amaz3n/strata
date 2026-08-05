import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"

import { PayablesDesk } from "./payables-desk"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { listSavedPayableViews } from "@/lib/services/payable-views"

export const dynamic = "force-dynamic"

export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ community?: string; tab?: string; q?: string; page?: string; pageSize?: string }> }) {
  const params = await searchParams
  const [scope, { orgId }] = await Promise.all([
    resolveProductionDeskScope({ communityId: params.community }),
    requireOrgContext(),
  ])
  // Approval routing only means something once the builder has a rail to release
  // money on.
  const railOpen = await isVendorPayoutSetupOpen(orgId)
  const [data, routing, savedViews] = await Promise.all([
    loadOrgPayablesDesk(scope.projectIds, {
      tab: params.tab,
      search: params.q,
      page: Number(params.page) || 1,
      pageSize: Number(params.pageSize) || 50,
    }),
    railOpen ? getPaymentApprovalRouting(orgId).catch(() => null) : Promise.resolve(null),
    listSavedPayableViews().catch(() => []),
  ])

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" />
      <PayablesDesk data={data} savedViews={savedViews} railOpen={railOpen} viewerMayApproveRuns={Boolean(routing?.viewerMayApprove)} />
    </PageLayout>
  )
}
