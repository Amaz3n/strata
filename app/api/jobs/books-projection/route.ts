import { type NextRequest, NextResponse } from "next/server"

import { runBooksProjection } from "@/lib/services/books/projector"
import { recordProjectionFailures } from "@/lib/services/books/reconciliation"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

export const maxDuration = 300

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // `?full=1` ignores the watermark and rescans every source record. The scheduled
  // run stays incremental; this is the operator lever for a backfill, or for
  // recovering facts whose journal entry failed to post (see the repair sweep in
  // `books-maintenance`, which runs the same pass nightly).
  const full = ["1", "true"].includes((request.nextUrl.searchParams.get("full") ?? "").toLowerCase())
  // A minute short of maxDuration, so the run records which companies it did not
  // reach instead of being killed mid-company with nothing recorded.
  const result = await runBooksProjection({ full, deadline: Date.now() + 240_000 })
  const surfaced = await recordProjectionFailures(result.results, { full })
  const failures = result.results.reduce((sum, item) => sum + item.failures.length, 0)
  return NextResponse.json({ ok: failures === 0, failures, surfaced, ...result }, { status: failures === 0 ? 200 : 207 })
}

export const GET = withCronRun("books-projection", handler)
