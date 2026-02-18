import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueuePaymentSync } from "@/lib/services/qbo-sync"
import { extractIntuitEntityEvents, verifyIntuitWebhookSignature } from "@/lib/integrations/accounting/qbo-webhook"
import { logQBO } from "@/lib/services/qbo-logger"

const WEBHOOK_SECRET = process.env.QBO_WEBHOOK_SECRET
const WEBHOOK_VERIFIER_TOKEN = process.env.QBO_WEBHOOK_VERIFIER_TOKEN

export async function POST(request: NextRequest) {
  const supabase = createServiceSupabaseClient()
  const legacySecret = request.headers.get("x-qbo-webhook-secret")
  const rawPayload = await request.text()
  const payloadHash = createHash("sha256").update(rawPayload).digest("hex")

  if (legacySecret) {
    if (!WEBHOOK_SECRET || legacySecret !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = JSON.parse(rawPayload || "{}") as any
    const paymentId = body?.payment_id as string | undefined

    if (!paymentId) {
      return NextResponse.json({ error: "payment_id required" }, { status: 400 })
    }

    const { data: payment } = await supabase.from("payments").select("org_id").eq("id", paymentId).maybeSingle()
    if (!payment?.org_id) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    await enqueuePaymentSync(paymentId, payment.org_id)
    logQBO("info", "payment_webhook_legacy_enqueued", { paymentId, orgId: payment.org_id, payloadHash })
    return NextResponse.json({ success: true })
  }

  const signature = request.headers.get("intuit-signature")
  const isValid = verifyIntuitWebhookSignature({
    payload: rawPayload,
    signatureHeader: signature,
    verifierToken: WEBHOOK_VERIFIER_TOKEN,
  })

  if (!isValid) {
    logQBO("warn", "payment_webhook_invalid_signature", { hasSignature: Boolean(signature) })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const payload = JSON.parse(rawPayload || "{}")
  const events = extractIntuitEntityEvents(payload)
  if (events.length === 0) {
    return NextResponse.json({ received: true, processed: 0 })
  }

  let inserted = 0
  for (const event of events) {
    const { error } = await supabase.from("qbo_webhook_events").insert({
      event_id: event.eventId,
      payload_hash: payloadHash,
      realm_id: event.realmId,
      entity_name: event.entityName,
      entity_qbo_id: event.entityId,
      operation: event.operation,
      last_updated: event.lastUpdated !== "unknown-time" ? new Date(event.lastUpdated).toISOString() : null,
      received_at: new Date().toISOString(),
    })
    if (!error) inserted += 1
  }

  logQBO("info", "payment_webhook_intuit_received", {
    eventsReceived: events.length,
    eventsInserted: inserted,
  })
  return NextResponse.json({ received: true, processed: inserted })
}

export const runtime = "nodejs"
