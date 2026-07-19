import { type NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runSelectionCutoffSweep } from "@/lib/services/selection-cutoffs"

export const runtime = "nodejs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return NextResponse.json(await runSelectionCutoffSweep())
}

export const POST = withCronRun("selection-cutoff-sweep", handler)
export const GET = POST
