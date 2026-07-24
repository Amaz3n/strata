import { NextRequest, NextResponse } from "next/server"

import { listProviders } from "@/lib/integrations/accounting/registry"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

const BATCH_SIZE = 50

async function processInboundAccountingEvents(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let processed = 0
  let reconciled = 0
  for (const provider of listProviders()) {
    if (!provider.drainInboundEvents) continue
    const result = await provider.drainInboundEvents({ limit: BATCH_SIZE })
    processed += result.processed
    reconciled += result.reconciled
  }

  return NextResponse.json({ processed, reconciled })
}

export const GET = withCronRun("accounting-process-inbound", processInboundAccountingEvents)
export const POST = GET

export const runtime = "nodejs"
