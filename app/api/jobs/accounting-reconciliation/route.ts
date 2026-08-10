import { type NextRequest, NextResponse } from "next/server"

import { runNightlyAccountingReconciliation } from "@/lib/services/books/reconciliation"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await runNightlyAccountingReconciliation()
  return NextResponse.json(
    { ok: result.failures.length === 0, ...result },
    { status: result.failures.length === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("accounting-reconciliation", handler)
