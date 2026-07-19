import { type NextRequest, NextResponse } from "next/server"
import { after } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runStartsPipeline } from "@/lib/services/starts-pipeline"

export const runtime = "nodejs"
export const maxDuration = 300

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  after(async () => { await runStartsPipeline({ deadlineMs: Date.now() + 270_000 }) })
  return NextResponse.json({ ok: true, message: "Starts pipeline run started" }, { status: 202 })
}

export const GET = withCronRun("starts-pipeline", handler)
export const POST = GET
