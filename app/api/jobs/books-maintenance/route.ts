import { type NextRequest, NextResponse } from "next/server"

import { processRecurringPostings } from "@/lib/services/books/bookkeeping"
import { finalizeExpiredCutoverCredentials } from "@/lib/services/books/cutover"
import { runScheduledLedgerRebuildDrills } from "@/lib/services/books/rebuild"
import { withCronRun } from "@/lib/services/job-runs"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const expected = process.env.CRON_SECRET
  const bearer = request.headers.get("authorization")
  if (expected) return bearer === `Bearer ${expected}` || request.headers.get("x-cron-secret") === expected
  return request.headers.get("x-vercel-cron") === "1"
}

async function handler(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const [recurring, credentials, rebuilds] = await Promise.all([
    processRecurringPostings(),
    finalizeExpiredCutoverCredentials(),
    runScheduledLedgerRebuildDrills(),
  ])
  return NextResponse.json({ ok: true, recurring, credentials, rebuilds })
}

export const GET = withCronRun("books-maintenance", handler)
