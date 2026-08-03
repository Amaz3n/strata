import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { listUnpayableVendorsWithOpenBills } from "@/lib/services/vendor-payment-invitations"

import { PayablesDesk } from "./payables-desk"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { VendorPaymentNudge } from "@/components/payables/vendor-payment-nudge"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ community?: string }> }) {
  const params = await searchParams
  const [scope, { orgId }] = await Promise.all([
    resolveProductionDeskScope({ communityId: params.community }),
    requireOrgContext(),
  ])
  // Only worth asking vendors to set up direct deposit once the builder has a
  // rail for them to set it up against.
  const railOpen = await isVendorPayoutSetupOpen(orgId)
  const [data, unpayableVendors, routing] = await Promise.all([
    loadOrgPayablesDesk(scope.projectIds),
    railOpen ? listUnpayableVendorsWithOpenBills(scope.projectIds).catch(() => []) : Promise.resolve([]),
    railOpen ? getPaymentApprovalRouting(orgId).catch(() => null) : Promise.resolve(null),
  ])

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" />
      <VendorPaymentNudge vendors={unpayableVendors} />
      <PayablesDesk data={data} railOpen={railOpen} viewerMayApproveRuns={Boolean(routing?.viewerMayApprove)} />
    </PageLayout>
  )
}
