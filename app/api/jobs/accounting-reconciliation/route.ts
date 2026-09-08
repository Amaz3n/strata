import { type NextRequest, NextResponse } from "next/server"

import { captureAccountingAcceptance } from "@/lib/services/accounting-acceptance"
import { runNightlyAccountingReconciliation } from "@/lib/services/books/reconciliation"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await runNightlyAccountingReconciliation()
  const acceptance = await captureAccountingAcceptance(result)
  const ok = result.failures.length === 0 && acceptance.failedSamples === 0
  return NextResponse.json({ ok, ...result, acceptance }, { status: ok ? 200 : 207 })
}

export const GET = withCronRun("accounting-reconciliation", handler)
