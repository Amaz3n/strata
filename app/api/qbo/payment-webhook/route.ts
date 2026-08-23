import { NextRequest, NextResponse } from "next/server"

import { getProvider } from "@/lib/integrations/accounting/registry"
import { logQBO } from "@/lib/services/accounting-logger"

// Signature-verified Intuit deliveries only. A legacy shared-secret bypass
// (`x-qbo-webhook-secret`) used to sit ahead of verification on this publicly
// registered URL with zero senders left anywhere — attack surface, not compat.
export async function POST(request: NextRequest) {
  const rawPayload = await request.text()

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
