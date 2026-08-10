import { after } from "next/server"
import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { hasPendingSpecJobs, runSpecsPipeline } from "@/lib/services/specs-pipeline"
import { triggerSpecsPipeline } from "@/lib/services/specs-pipeline-trigger"

export const runtime = "nodejs"
export const maxDuration = 300

async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await hasPendingSpecJobs())) return NextResponse.json({ ok: true, message: "No pending specification jobs" })
  after(async () => {
    const summary = await runSpecsPipeline({ deadlineMs: Date.now() + 270_000 })
    if (summary.remaining > 0) await triggerSpecsPipeline()
  })
  return NextResponse.json({ ok: true, message: "Specifications pipeline started" }, { status: 202 })
}

export const GET = withCronRun("specs-pipeline", handle)
export const POST = GET
