import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { releaseMaturedVendorTransfers } from "@/lib/services/payment-payouts"
import { recoverAmbiguousPaymentSubmissions, releaseScheduledPaymentRuns } from "@/lib/services/payment-runs"

/**
 * The money tick.
 *
 * Split out of `payment-controls` because these two operations are the only
 * payment work whose cost is measured in minutes rather than a day:
 *
 * - a run the preparer scheduled for today has to go out today, and a missed
 *   window used to mean the whole day's AP waited until tomorrow;
 * - an ambiguous submission is the one state where Arc cannot say whether the
 *   builder's bank was debited, and leaving that unresolved for up to 24 hours
 *   is indefensible.
 *
 * Both fail closed on the same execution kill switch as a manual release and
 * both are idempotent, so a double fire is a no-op and a missed fire is repaired
 * five minutes later.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const scheduledReleases = await releaseScheduledPaymentRuns()
  const submissionRecovery = await recoverAmbiguousPaymentSubmissions()
  // Cleared funds whose payout hold has expired. Minute-sensitive for the same
  // reason as the rest of this tick: every hour past the hold is an hour the
  // vendor is waiting on money Arc is already holding.
  const vendorTransfers = await releaseMaturedVendorTransfers()
  return NextResponse.json({ scheduledReleases, submissionRecovery, vendorTransfers })
}

export const POST = withCronRun("payment-release", handler)
export const GET = POST
