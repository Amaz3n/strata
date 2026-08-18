import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepExpiredLotHolds } from "@/lib/services/community-sales"


async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await sweepExpiredLotHolds())
}

export const GET = withCronRun("lot-hold-sweep", handler)
export const POST = GET
