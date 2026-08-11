import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runScheduledPaymentReconciliations } from "@/lib/services/payment-reconciliation"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The daily provider-versus-Arc reconciliation batch.
 *
 * Genuinely a daily job — it compares a closed 24-hour period — so it keeps its
 * own route rather than riding the five-minute money tick, where it would issue
 * a full period's worth of provider calls 288 times a day.
 */
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const enabled = process.env.FINTECH_PAYMENTS_RECONCILIATION_ENABLED === "true"
  if (!enabled) {
    const supabase = createServiceSupabaseClient()
    const { count, error } = await supabase.from("payment_rail_policies")
      .select("id", { count: "exact", head: true })
      .eq("enabled", true)
    if (error) throw new Error(`Unable to check enabled payment rails: ${error.message}`)
    if ((count ?? 0) > 0) {
      return NextResponse.json({
        error: "Payment reconciliation is disabled while payment rails are enabled",
        enabledRailCount: count,
        reconciliationEnabled: false,
      }, { status: 503 })
    }
    return NextResponse.json({ reconciliations: [], reconciliationEnabled: false })
  }
  const reconciliations = await runScheduledPaymentReconciliations()
  return NextResponse.json({ reconciliations, reconciliationEnabled: true })
}

export const POST = withCronRun("payment-reconciliation", handler)
export const GET = POST
