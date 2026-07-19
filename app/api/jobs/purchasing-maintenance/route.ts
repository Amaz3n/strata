import { type NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runPurchasingMaintenance } from "@/lib/services/purchasing-maintenance"

export const runtime = "nodejs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await runPurchasingMaintenance())
}

export const POST = withCronRun("purchasing-maintenance", handler)
export const GET = POST
