import { NextRequest, NextResponse } from "next/server"

import { findDueReminders, findLateFeeCandidates } from "@/lib/services/payments"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const reminders = await findDueReminders()
  const lateFees = await findLateFeeCandidates()
  return NextResponse.json({
    reminders_due: reminders.length,
    late_fee_candidates: lateFees.length,
  })
}





