import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueuePaymentSync } from "@/lib/services/accounting-sync"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { logQBO } from "@/lib/services/accounting-logger"

const WEBHOOK_SECRET = process.env.QBO_WEBHOOK_SECRET

export async function POST(request: NextRequest) {
  const legacySecret = request.headers.get("x-qbo-webhook-secret")
  const rawPayload = await request.text()

  if (legacySecret) {
    if (!WEBHOOK_SECRET || legacySecret !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = createServiceSupabaseClient()
    const body = JSON.parse(rawPayload || "{}") as { payment_id?: string }
    const paymentId = body?.payment_id

    if (!paymentId) {
      return NextResponse.json({ error: "payment_id required" }, { status: 400 })
    }

    const { data: payment } = await supabase.from("payments").select("org_id").eq("id", paymentId).maybeSingle()
    if (!payment?.org_id) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    await enqueuePaymentSync(paymentId, payment.org_id)
    logQBO("info", "payment_webhook_legacy_enqueued", {
      paymentId,
      orgId: payment.org_id,
      payloadHash: createHash("sha256").update(rawPayload).digest("hex"),
    })
    return NextResponse.json({ success: true })
  }

  // This URL is registered with Intuit, so the provider is QBO by construction.
  const provider = getProvider("qbo")
  if (!provider.receiveWebhook) {
    return NextResponse.json({ error: "Webhooks not supported" }, { status: 400 })
  }
  const result = await provider.receiveWebhook({
    rawBody: rawPayload,
    headers: { "intuit-signature": request.headers.get("intuit-signature") },
  })
  if (!result) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  logQBO("info", "payment_webhook_intuit_received", {
    eventsReceived: result.received,
    eventsInserted: result.inserted,
  })
  return NextResponse.json({ received: true, processed: result.inserted })
}

export const runtime = "nodejs"
