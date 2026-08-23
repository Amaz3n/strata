import { NextRequest, NextResponse } from "next/server"

import { listProviders } from "@/lib/integrations/accounting/registry"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

// Small batches inside a wall-clock budget: each event costs 1–3 QBO round
// trips, so one big batch of 50 could blow the 120s maxDuration — and a
// platform timeout never returns, leaving no job_runs row at all. Draining
// chunks until the budget runs out processes just as much under load while
// always finishing with telemetry.
const BATCH_SIZE = 10
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
  for (const provider of listProviders()) {
    if (!provider.drainInboundEvents) continue
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const result = await provider.drainInboundEvents({ limit: BATCH_SIZE })
      processed += result.processed
      reconciled += result.reconciled
      ignored += result.ignored ?? 0
      errored += result.errored ?? 0
      if (result.processed < BATCH_SIZE) break
    }
  }

  return NextResponse.json({ processed, reconciled, ignored, errored })
}

export const GET = withCronRun("accounting-process-inbound", processInboundAccountingEvents)
export const POST = GET
