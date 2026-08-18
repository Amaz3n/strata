import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepWarrantyCourtesyInspections } from "@/lib/services/warranty"


async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await sweepWarrantyCourtesyInspections())
}

export const GET = withCronRun("warranty-courtesy-inspections", handler)
export const POST = GET
