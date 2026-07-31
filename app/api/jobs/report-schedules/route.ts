import { NextRequest, NextResponse } from "next/server"
import { withCronRun } from "@/lib/services/job-runs"
import { processDueReportSchedules } from "@/lib/services/report-configs"

export const runtime = "nodejs"
const CRON_SECRET = process.env.CRON_SECRET

async function handler(request: NextRequest) {
  const authorized = CRON_SECRET ? request.headers.get("authorization") === `Bearer ${CRON_SECRET}` || request.headers.get("x-cron-secret") === CRON_SECRET : process.env.NODE_ENV !== "production"
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const outcomes = await processDueReportSchedules()
  return NextResponse.json({ processed: outcomes.length, failed: outcomes.filter((item) => !item.ok) })
}

export const GET = withCronRun("report-schedules", handler)
