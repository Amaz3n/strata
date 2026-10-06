import { type NextRequest, NextResponse } from "next/server"
import { after } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runStartsPipeline } from "@/lib/services/starts-pipeline"

export const maxDuration = 300

const runTrackedWorker = withCronRun("starts-pipeline", async () => {
  const summary = await runStartsPipeline({ deadlineMs: Date.now() + 270_000 })
  return NextResponse.json({ ok: summary.failed === 0, ...summary }, { status: summary.failed > 0 ? 207 : 200 })
})

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  after(async () => { await runTrackedWorker(request) })
  return NextResponse.json({ ok: true, message: "Starts pipeline run started" }, { status: 202 })
}

export const GET = handler
export const POST = GET
