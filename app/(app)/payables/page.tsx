import LoadingPayables from "./loading"
import { Suspense } from "react"
import { connection } from "next/server"
import { parsePayablesBookQuery } from "@/lib/financials/payables-book"
import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"

import { PayablesDesk } from "@/components/payables/payables-desk"
import { PayrollCommissionsBand, PayrollCommissionsBandError, PayrollCommissionsBandSkeleton } from "@/components/payables/payroll-commissions-band"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { listBlockedPaymentRuns } from "@/lib/services/payment-risk"
import { hasAnyPermission } from "@/lib/services/permissions"
import { listPaymentRuns } from "@/lib/services/payment-runs"
import { listPayrollCommissionsDue } from "@/lib/services/sales-commissions"


async function PayablesPageContent({ searchParams }: { searchParams: Promise<Record<string, string | undefined> & { community?: string; tab?: string; q?: string; page?: string; pageSize?: string; run?: string; bill?: string; due?: string }> }) {
  await connection()
  const params = await searchParams
  const [scope, { orgId, userId }] = await Promise.all([
    resolveProductionDeskScope({ communityId: params.community }),
    requireOrgContext(),
  ])
  const paymentPromise = isVendorPayoutSetupOpen(orgId).then(async (railOpen) => {
    if (!railOpen) return { railOpen, routing: null, blockedRuns: [], approvalRuns: [] }
    // Risk data requires its own permission. Routing and the viewer's pending
    // approvals can load independently of that check and the bill register.
    const blockedRunsPromise = hasAnyPermission(["payment.approve_run", "payment.reconcile"])
      .then((mayViewRiskQueue) => mayViewRiskQueue ? listBlockedPaymentRuns() : [])
    const [routing, blockedRuns, approvalRuns] = await Promise.all([
      getPaymentApprovalRouting(orgId).catch(() => null),
      blockedRunsPromise,
      listPaymentRuns().then((runs) => runs.filter((run) => run.status === "pending_approval" && run.can_approve)),
    ])
    return { railOpen, routing, blockedRuns, approvalRuns }
  })
  const [data, { railOpen, routing, blockedRuns, approvalRuns }] = await Promise.all([
    loadOrgPayablesDesk(scope.projectIds, {
      ...parsePayablesBookQuery(params),
      search: params.q,
      page: Number(params.page) || 1,
      pageSize: Number(params.pageSize) || 25,
      billId: params.bill,
    }),
    paymentPromise,
  ])

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" />
      <Suspense fallback={<PayrollCommissionsBandSkeleton />}>
        <PayrollCommissionsDue />
      </Suspense>
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

/** Commission comp and clawbacks the next payroll run carries; only payment releasers see them. */
async function PayrollCommissionsDue() {
  if (!(await hasAnyPermission(["payment.release"]))) return null
  const due = await listPayrollCommissionsDue().then(
    (result) => ({ ok: true as const, ...result }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "Payroll commissions could not be loaded." }),
  )
  if (!due.ok) return <PayrollCommissionsBandError message={due.error} />
  return <PayrollCommissionsBand rows={due.rows} truncated={due.truncated} />
}

export default function PayablesPage(props: Parameters<typeof PayablesPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Payables" fullBleed><LoadingPayables /></PageLayout>}>
      <PayablesPageContent {...props} />
    </Suspense>
  )
}
