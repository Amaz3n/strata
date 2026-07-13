import { after } from "next/server"
import { NextRequest, NextResponse } from "next/server"

import { withCronRun } from "@/lib/services/job-runs"
import { hasPendingSpecJobs, runSpecsPipeline } from "@/lib/services/specs-pipeline"
import { triggerSpecsPipeline } from "@/lib/services/specs-pipeline-trigger"

export const runtime = "nodejs"
export const maxDuration = 300

function authorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const secret = process.env.CRON_SECRET
  if (secret) return request.headers.get("authorization") === `Bearer ${secret}` || request.headers.get("x-cron-secret") === secret
  return request.headers.get("x-vercel-cron") === "1"
}

async function handle(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await hasPendingSpecJobs())) return NextResponse.json({ ok: true, message: "No pending specification jobs" })
  after(async () => {
    const summary = await runSpecsPipeline({ deadlineMs: Date.now() + 270_000 })
    if (summary.remaining > 0) await triggerSpecsPipeline()
  })
  return NextResponse.json({ ok: true, message: "Specifications pipeline started" }, { status: 202 })
}

export const GET = withCronRun("specs-pipeline", handle)
export const POST = GET
