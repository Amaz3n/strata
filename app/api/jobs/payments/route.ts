import { NextResponse } from "next/server"

import { findDueReminders, findLateFeeCandidates } from "@/lib/services/payments"

export async function GET() {
  const reminders = await findDueReminders()
  const lateFees = await findLateFeeCandidates()
  return NextResponse.json({
    reminders_due: reminders.length,
    late_fee_candidates: lateFees.length,
  })
}

