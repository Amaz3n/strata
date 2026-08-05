import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { activateMaturedFundingSourceChanges } from "@/lib/services/payment-rail-setup"

/**
 * Payment security controls.
 *
 * Only funding-source cooling periods live here now. Scheduled release and
 * ambiguous-submission recovery moved to `/api/jobs/payment-release` (every five
 * minutes) and reconciliation to `/api/jobs/payment-reconciliation` (daily) —
 * carrying all four on one daily tick meant one missed request skipped an entire
 * day of AP with nothing to say so.
 *
 * Hourly rather than daily because a cooling period that matures at 09:00 should
 * not wait until the next day's batch window to let its owner use the bank.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const activation = await activateMaturedFundingSourceChanges()
  return NextResponse.json({ activation })
}

export const POST = withCronRun("payment-controls", handler)
export const GET = POST
