import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { activateMaturedFundingSourceChanges } from "@/lib/services/payment-rail-setup"
import { runScheduledPaymentReconciliations } from "@/lib/services/payment-reconciliation"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const activation = await activateMaturedFundingSourceChanges()
  const reconciliations = process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED === "true"
    ? await runScheduledPaymentReconciliations()
    : []
  return NextResponse.json({ activation, reconciliations, reconciliationEnabled: process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED === "true" })
}

export const POST = withCronRun("payment-controls", handler)
export const GET = POST
