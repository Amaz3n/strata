import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { processDueReportSchedules } from "@/lib/services/report-configs"


async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const outcomes = await processDueReportSchedules()
  return NextResponse.json({ processed: outcomes.length, failed: outcomes.filter((item) => !item.ok) })
}

export const GET = withCronRun("report-schedules", handler)
