import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { processDueReportSchedules } from "@/lib/services/report-configs"


async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const outcomes = await processDueReportSchedules()
  const failed = outcomes.filter((item) => !item.ok)
  return NextResponse.json(
    { ok: failed.length === 0, processed: outcomes.length, failed },
    { status: failed.length === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("report-schedules", handler)
