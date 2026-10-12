import { type NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { sweepAgreementMilestoneDeadlines } from "@/lib/services/agreement-milestones"
import { sweepExpiredLotHolds } from "@/lib/services/community-sales"

/**
 * The sales desk's sweep: expired lot holds are released, and contingencies and
 * lender/title milestones coming due are announced to their owners.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const [holds, milestones] = await Promise.all([sweepExpiredLotHolds(), sweepAgreementMilestoneDeadlines()])
  return NextResponse.json({ holds, milestones })
}

export const GET = withCronRun("lot-hold-sweep", handler)
export const POST = GET
