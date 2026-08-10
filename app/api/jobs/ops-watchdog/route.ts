import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runOpsWatchdog } from "@/lib/services/ops-watchdog"

/**
 * Reads the heartbeat every other cron writes.
 *
 * Returns 500 when a critical finding is open so the run lands in `job_runs` as
 * failed and shows up wherever cron health is already surfaced — a watchdog that
 * always returns 200 needs its own watchdog.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { findings } = await runOpsWatchdog()
  const critical = findings.filter((finding) => finding.severity === "critical")
  return NextResponse.json({ findings, criticalCount: critical.length }, { status: critical.length > 0 ? 500 : 200 })
}

export const POST = withCronRun("ops-watchdog", handler)
export const GET = POST
