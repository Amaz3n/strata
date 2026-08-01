import { PageLayout } from "@/components/layout/page-layout"
import { listPaymentReconciliations } from "@/lib/services/payment-reconciliation"
import {
  getPaymentRunSetupData,
  listPaymentRuns,
  type PaymentRunListRow,
  type PaymentRunSetupData,
} from "@/lib/services/payment-runs"
import type { PaymentReconciliationSummary } from "@/lib/services/payment-reconciliation"

import { PaymentRunsClient } from "./payment-runs-client"

export const dynamic = "force-dynamic"

export default async function PaymentRunsPage() {
  let error: string | null = null
  let setup: PaymentRunSetupData = { fundingSources: [], eligibleBills: [] }
  let runs: PaymentRunListRow[] = []
  let reconciliations: PaymentReconciliationSummary[] = []
  const [setupResult, runsResult, reconciliationResult] = await Promise.allSettled([
    getPaymentRunSetupData(),
    listPaymentRuns(),
    listPaymentReconciliations(),
  ])
  if (setupResult.status === "fulfilled") setup = setupResult.value
  if (runsResult.status === "fulfilled") runs = runsResult.value
  if (reconciliationResult.status === "fulfilled") reconciliations = reconciliationResult.value
  const coreFailure = setupResult.status === "rejected"
    ? setupResult.reason
    : runsResult.status === "rejected"
      ? runsResult.reason
      : null
  if (coreFailure) {
    error = coreFailure instanceof Error ? coreFailure.message : "Unable to load payment operations"
  }
  return <PageLayout fullBleed><PaymentRunsClient setup={setup} runs={runs} reconciliations={reconciliations} canReconcile={reconciliationResult.status === "fulfilled"} error={error} /></PageLayout>
}
