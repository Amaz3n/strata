import { type NextRequest, NextResponse } from "next/server"

import { captureNightlyForecastSnapshots } from "@/lib/services/forecast-snapshots"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await captureNightlyForecastSnapshots()
  return NextResponse.json({ ok: result.failed.length === 0, ...result }, { status: result.failed.length === 0 ? 200 : 207 })
}

export const GET = withCronRun("forecast-snapshots", handler)
