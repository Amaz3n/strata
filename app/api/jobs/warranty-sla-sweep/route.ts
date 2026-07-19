import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepWarrantySlaBreaches } from "@/lib/services/warranty"

export const runtime = "nodejs"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await sweepWarrantySlaBreaches())
}

export const GET = withCronRun("warranty-sla-sweep", handler)
export const POST = GET
