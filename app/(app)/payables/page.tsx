import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { parsePayablesBookQuery } from "@/lib/financials/payables-book"
import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"

import { PayablesDesk } from "@/components/payables/payables-desk"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { listBlockedPaymentRuns } from "@/lib/services/payment-risk"
import { hasAnyPermission } from "@/lib/services/permissions"
import { listPaymentRuns } from "@/lib/services/payment-runs"


async function PayablesPageContent({ searchParams }: { searchParams: Promise<Record<string, string | undefined> & { community?: string; tab?: string; q?: string; page?: string; pageSize?: string; run?: string; bill?: string; due?: string }> }) {
  const params = await searchParams
  const [scope, { orgId, userId }] = await Promise.all([
    resolveProductionDeskScope({ communityId: params.community }),
    requireOrgContext(),
  ])
  // Every tab switch re-runs this page, so nothing here waits on anything it does
  // not need. The desk query does not depend on the rail being open, and the two
  // rail-dependent reads are the only pair that has to follow it.
  const [data, railOpen] = await Promise.all([
    loadOrgPayablesDesk(scope.projectIds, {
      ...parsePayablesBookQuery(params),
      search: params.q,
      page: Number(params.page) || 1,
      pageSize: Number(params.pageSize) || 25,
      billId: params.bill,
    }),
    // Approval routing and risk blocks only mean something once the builder has
    // a rail to release money on.
    isVendorPayoutSetupOpen(orgId),
  ])
  // Whether the viewer may see the risk queue is a permission fact checked up
  // front, not an error swallowed after the fact — a real failure loading the
  // queue should surface, never render as "no blocked runs".
  const mayViewRiskQueue = railOpen && (await hasAnyPermission(["payment.approve_run", "payment.reconcile"]))
  const [routing, blockedRuns, approvalRuns] = railOpen
    ? await Promise.all([
        getPaymentApprovalRouting(orgId).catch(() => null),
        // Empty on a normal day, which is the point — it renders nothing then.
        mayViewRiskQueue ? listBlockedPaymentRuns() : Promise.resolve([]),
        // A load failure belongs in the desk error boundary; silently rendering
        // no band would tell an approver there is no work when the read failed.
        listPaymentRuns().then((runs) => runs.filter((run) => run.status === "pending_approval" && run.can_approve)),
      ])
    : [null, [], []]

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" />
      <PayablesDesk
        data={data}
        railOpen={railOpen}
        blockedRuns={blockedRuns}
        approvalRuns={approvalRuns}
        viewerMayApproveRuns={Boolean(routing?.viewerMayApprove)}
        approvalViewer={{ userId, approvers: routing?.approvers ?? [] }}
      />
    </PageLayout>
  )
}

export default function PayablesPage(props: Parameters<typeof PayablesPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PayablesPageContent {...props} />
    </Suspense>
  )
}
