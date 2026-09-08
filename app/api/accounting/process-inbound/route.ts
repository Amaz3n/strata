import { NextRequest, NextResponse } from "next/server"

import { withAccountingDeadline } from "@/lib/services/accounting-delivery"
import { listProviders } from "@/lib/integrations/accounting/registry"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

// Small batches inside a wall-clock budget: each event costs 1–3 QBO round
// trips, so one big batch of 50 could blow the 120s maxDuration — and a
// platform timeout never returns, leaving no job_runs row at all. Draining
// chunks until the budget runs out processes just as much under load while
// always finishing with telemetry.
const BATCH_SIZE = 1
const TIME_BUDGET_MS = 85_000

async function processInboundAccountingEvents(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()
  let processed = 0
  let reconciled = 0
  let ignored = 0
  let errored = 0
  const eligible = listProviders().filter(provider => provider.drainInboundEvents)
  // Rotate the starting provider between runs, then give each one a bounded turn.
  const startIndex = Math.floor(startedAt / 60_000) % Math.max(eligible.length, 1)
  const providers = [...eligible.slice(startIndex), ...eligible.slice(0, startIndex)]
  let active = providers
  while (active.length && Date.now() - startedAt < TIME_BUDGET_MS) {
    const next = []
    for (const provider of active) {
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break
      const result = await withAccountingDeadline(startedAt + TIME_BUDGET_MS, () => provider.drainInboundEvents!({ limit: BATCH_SIZE }))
      processed += result.processed
      reconciled += result.reconciled
      ignored += result.ignored ?? 0
      errored += result.errored ?? 0
      if (result.processed >= BATCH_SIZE) next.push(provider)
    }
    active = next
  }

  return NextResponse.json({ processed, reconciled, ignored, errored }, { status: errored > 0 ? 207 : 200 })
}

export const GET = withCronRun("accounting-process-inbound", processInboundAccountingEvents)
export const POST = GET
