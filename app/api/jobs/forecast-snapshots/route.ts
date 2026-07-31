import { type NextRequest, NextResponse } from "next/server"

import { captureNightlyForecastSnapshots } from "@/lib/services/forecast-snapshots"
import { withCronRun } from "@/lib/services/job-runs"

const CRON_SECRET = process.env.CRON_SECRET

function authorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const bearer = request.headers.get("authorization") ?? request.headers.get("Authorization")
  if (CRON_SECRET) return bearer === `Bearer ${CRON_SECRET}` || request.headers.get("x-cron-secret") === CRON_SECRET
  return request.headers.get("x-vercel-cron") === "1"
}

async function handler(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await captureNightlyForecastSnapshots()
  return NextResponse.json({ ok: result.failed.length === 0, ...result }, { status: result.failed.length === 0 ? 200 : 207 })
}

export const GET = withCronRun("forecast-snapshots", handler)
