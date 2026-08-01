import { type NextRequest, NextResponse } from "next/server"

import { processPendingBankFeedEvents } from "@/lib/services/books/bank-feeds"
import { withCronRun } from "@/lib/services/job-runs"

function authorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const expected = process.env.CRON_SECRET
  const bearer = request.headers.get("authorization")
  if (expected) return bearer === `Bearer ${expected}` || request.headers.get("x-cron-secret") === expected
  return request.headers.get("x-vercel-cron") === "1"
}

async function handler(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await processPendingBankFeedEvents()
  return NextResponse.json(
    { ok: result.failures.length === 0, ...result },
    { status: result.failures.length === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("bank-feed-sync", handler)

