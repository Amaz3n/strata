import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepPermitDeadlines } from "@/lib/services/permits"

/**
 * The permit coordinator's sweep: correction responses coming due or late, and
 * decisions past the authority's review time, announced once each to whoever owns them.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await sweepPermitDeadlines())
}

export const GET = withCronRun("permit-reminders", handler)
export const POST = GET
