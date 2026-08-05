import { PageLayout } from "@/components/layout/page-layout"
import { listOpenPaymentReconciliationExceptions, listPaymentReconciliations } from "@/lib/services/payment-reconciliation"
import {
  getPaymentRunSetupData,
  listPaymentRuns,
  type PaymentRunListRow,
  type PaymentRunSetupData,
} from "@/lib/services/payment-runs"
import type { PaymentReconciliationException, PaymentReconciliationSummary } from "@/lib/services/payment-reconciliation"
import { listBlockedPaymentRuns, type BlockedPaymentRun } from "@/lib/services/payment-risk"

import { PaymentRunsClient } from "./payment-runs-client"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

export default async function PaymentRunsPage({ searchParams }: { searchParams: Promise<{ bills?: string; community?: string }> }) {
  const { bills, community } = await searchParams
  const scope = await resolveProductionDeskScope({ communityId: community })
  const preselectedBillIds = bills ? bills.split(",").filter(Boolean) : []
  let error: string | null = null
  let setup: PaymentRunSetupData = {
    fundingSources: [],
    eligibleBills: [],
    routing: { rosterConfigured: false, approvers: [], viewerMayApprove: false, viewerUserId: "" },
    // Only reached when setup itself failed to load, in which case the page shows
    // the error and there is nothing to schedule against anyway.
    settlementWindow: { debitBusinessDays: { min: 0, max: 0 }, payoutBusinessDays: { min: 0, max: 0 } },
    feePolicy: { platformFeeFlatCents: 0, platformFeeBps: 0, passThroughProcessorFees: true },
  }
  let runs: PaymentRunListRow[] = []
  let reconciliations: PaymentReconciliationSummary[] = []
  let exceptions: PaymentReconciliationException[] = []
  let blockedRuns: BlockedPaymentRun[] = []
  const [setupResult, runsResult, reconciliationResult, exceptionResult, riskResult] = await Promise.allSettled([
    getPaymentRunSetupData(undefined, scope.projectIds),
    listPaymentRuns(undefined, scope.projectIds),
    listPaymentReconciliations(),
    listOpenPaymentReconciliationExceptions(),
    listBlockedPaymentRuns(),
  ])
  if (setupResult.status === "fulfilled") setup = setupResult.value
  if (runsResult.status === "fulfilled") runs = runsResult.value
  if (reconciliationResult.status === "fulfilled") reconciliations = reconciliationResult.value
  if (exceptionResult.status === "fulfilled") exceptions = exceptionResult.value
  if (riskResult.status === "fulfilled") blockedRuns = riskResult.value
  const coreFailure = setupResult.status === "rejected"
    ? setupResult.reason
    : runsResult.status === "rejected"
      ? runsResult.reason
      : null
  if (coreFailure) {
    error = coreFailure instanceof Error ? coreFailure.message : "Unable to load payment operations"
  }
  return <PageLayout fullBleed><DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" /><PaymentRunsClient setup={setup} runs={runs} reconciliations={reconciliations} exceptions={exceptions} blockedRuns={blockedRuns} canReviewRisk={riskResult.status === "fulfilled"} canReconcile={reconciliationResult.status === "fulfilled"} error={error} preselectedBillIds={preselectedBillIds} /></PageLayout>
}
