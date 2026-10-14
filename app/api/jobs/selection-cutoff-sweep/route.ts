import { type NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runSelectionCutoffSweep } from "@/lib/services/selection-cutoffs"


async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await runSelectionCutoffSweep()
  // 207 files a partial failure as failed telemetry; the steps that ran still ran.
  return NextResponse.json(result, { status: result.failures.length ? 207 : 200 })
}

export const POST = withCronRun("selection-cutoff-sweep", handler)
export const GET = POST
