import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"

import {
  hasPendingDrawingJobs,
  runDrawingsPipeline,
} from "@/lib/services/drawings-pipeline"
import { triggerDrawingsPipeline } from "@/lib/services/drawings-pipeline-trigger"
import { withCronRun } from "@/lib/services/job-runs"

export const runtime = "nodejs"
export const maxDuration = 300

const CRON_SECRET = process.env.CRON_SECRET

function isAuthorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true

  const authHeader = request.headers.get("authorization") ?? ""
  const legacyHeader = request.headers.get("x-cron-secret")
  const secretOk =
    (!!CRON_SECRET && authHeader.trim() === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) return secretOk
  return request.headers.get("x-vercel-cron") === "1"
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
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
      const summary = await runDrawingsPipeline({ deadlineMs: Date.now() + 270_000 })
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
