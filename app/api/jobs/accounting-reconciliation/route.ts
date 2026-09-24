import { type NextRequest, NextResponse } from "next/server"

import { captureAccountingAcceptance } from "@/lib/services/accounting-acceptance"
import { runNightlyAccountingReconciliation } from "@/lib/services/books/reconciliation"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await runNightlyAccountingReconciliation()
  const acceptance = await captureAccountingAcceptance(result)
  // Acceptance is a release decision, not an operational reconciliation failure.
  // Its persisted failed sample remains visible without poisoning tomorrow's cron-health gate.
  const ok = result.attempted === result.completed && result.failures.length === 0
  return NextResponse.json({ ok, ...result, acceptance }, { status: ok ? 200 : 207 })
}

export const GET = withCronRun("accounting-reconciliation", handler)
