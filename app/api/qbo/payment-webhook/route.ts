import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueuePaymentSync } from "@/lib/services/qbo-sync"

const WEBHOOK_SECRET = process.env.QBO_WEBHOOK_SECRET

export async function POST(request: NextRequest) {
  if (!WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  const secret = request.headers.get("x-qbo-webhook-secret")
  if (secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const paymentId = body?.payment_id as string | undefined

  if (!paymentId) {
    return NextResponse.json({ error: "payment_id required" }, { status: 400 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: payment } = await supabase.from("payments").select("org_id").eq("id", paymentId).maybeSingle()
  if (!payment?.org_id) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 })
  }

  await enqueuePaymentSync(paymentId, payment.org_id)
  return NextResponse.json({ success: true })
}
