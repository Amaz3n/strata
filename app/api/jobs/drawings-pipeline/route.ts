import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { after } from "next/server"

import {
  hasPendingDrawingJobs,
  runDrawingsPipeline,
} from "@/lib/services/drawings-pipeline"
import { triggerDrawingsPipeline } from "@/lib/services/drawings-pipeline-trigger"
import { withCronRun } from "@/lib/services/job-runs"

export const runtime = "nodejs"
export const maxDuration = 800

async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pending = await hasPendingDrawingJobs()
  if (!pending) {
    return NextResponse.json({ ok: true, message: "No pending drawing jobs" })
  }

  // Respond immediately; drain the queue after the response so callers
  // (upload actions, sibling invocations) never block on processing.
  after(async () => {
    try {
      const summary = await runDrawingsPipeline({ deadlineMs: Date.now() + 770_000 })
      console.log(
        `[drawings-pipeline] Run finished: ${summary.processed} processed, ${summary.failed} failed, ${summary.remaining} remaining`,
      )
      if (summary.remaining > 0) {
        // More work than one invocation could finish — chain another.
        await triggerDrawingsPipeline()
      }
    } catch (error) {
      console.error("[drawings-pipeline] Run crashed:", error)
    }
  })

  return NextResponse.json({ ok: true, message: "Pipeline run started" }, { status: 202 })
}

// Vercel Cron sends GET.
export const GET = withCronRun("drawings-pipeline", handle)
export const POST = GET
