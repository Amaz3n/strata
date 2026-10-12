import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepTakedownReminders } from "@/lib/services/communities"
import { sweepEntitlementDeadlines } from "@/lib/services/land-entitlements"
import { sweepLandDiligenceDeadlines } from "@/lib/services/land-opportunities"

/**
 * The daily land deadline sweep: takedowns and land contract money coming due,
 * diligence items and feasibility periods, and entitlement conditions, targets
 * and expiries. One job, so a land manager's deadlines arrive together.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const [takedowns, diligence, entitlements] = await Promise.all([
    sweepTakedownReminders(),
    sweepLandDiligenceDeadlines(),
    sweepEntitlementDeadlines(),
  ])
  return NextResponse.json({ takedowns, diligence, entitlements })
}

export const GET = withCronRun("takedown-reminders", handler)
export const POST = GET
