import { type NextRequest, NextResponse } from "next/server"

import { processRecurringPostings } from "@/lib/services/books/bookkeeping"
import { finalizeExpiredCutoverCredentials } from "@/lib/services/books/cutover"
import { runBooksProjection } from "@/lib/services/books/projector"
import { recordProjectionFailures } from "@/lib/services/books/reconciliation"
import { runScheduledLedgerRebuildDrills } from "@/lib/services/books/rebuild"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"

export const dynamic = "force-dynamic"
export const maxDuration = 300

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // The repair sweep. `accounting_facts` is append-only and the incremental
  // watermark is derived from it, so a fact whose journal entry fails to post
  // advances the watermark past itself and is never revisited — the ten-minute
  // run will not see it again. A full pass ignores the watermark; posting is
  // idempotent on the posting key, so re-scanning costs nothing when the ledger
  // is already whole and is the only thing that recovers it when it is not.
  const [recurring, credentials, rebuilds, repair] = await Promise.all([
    processRecurringPostings(),
    finalizeExpiredCutoverCredentials(),
    runScheduledLedgerRebuildDrills(),
    runBooksProjection({ full: true }),
  ])
  // Each unprojectable source becomes a reconciliation item with an owner and a
  // cure. Some of them — a bill edited after its period closed — fail identically
  // on every pass, so retrying is not a fix and a person has to decide.
  const surfaced = await recordProjectionFailures(repair.results)
  // The repair path exists BECAUSE failures were once invisible. Reporting `ok`
  // over a sweep that could not repair what it found is the same defect again, so
  // this reports exactly the way `books-projection` does.
  const failures = repair.results.reduce((sum, item) => sum + item.failures.length, 0)
  return NextResponse.json(
    { ok: failures === 0, failures, recurring, credentials, rebuilds, repair, surfaced },
    { status: failures === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("books-maintenance", handler)
