import { NextRequest, NextResponse } from "next/server"

import { runDueInvoiceSchedules } from "@/lib/services/invoice-schedules"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"

// Vercel Cron sends GET; POST kept for manual triggering.
async function handle(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const results = await runDueInvoiceSchedules()
    const created = results.filter((result) => result.status === "created").length
    const failed = results.filter((result) => result.status === "failed")
    return NextResponse.json({ ok: true, created, failed: failed.length, results })
  } catch (error) {
    console.error("[invoice-schedules] Cron run failed", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run invoice schedules" },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
