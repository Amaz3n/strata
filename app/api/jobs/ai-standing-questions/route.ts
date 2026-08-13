import { type NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepStandingQuestions } from "@/lib/services/ai-assistant/standing-questions"

// Ten questions through the full tool loop, sequentially.
export const maxDuration = 300

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await sweepStandingQuestions())
}

// Vercel Cron sends GET; POST is here so the job can be kicked by hand.
export const GET = withCronRun("ai-standing-questions", handler)
export const POST = GET
