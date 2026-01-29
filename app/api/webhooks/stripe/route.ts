import { NextRequest, NextResponse } from "next/server"

import { constructWebhookEvent, mapStripeEventToDomain } from "@/lib/integrations/payments/stripe"
import { recordPayment } from "@/lib/services/payments"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { upsertSubscriptionFromStripe } from "@/lib/services/subscriptions"

export async function POST(request: NextRequest) {
  const payload = await request.text()
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 })
  }

  let event
  try {
    event = constructWebhookEvent(payload, signature)
  } catch (err) {
    console.error("Webhook signature verification failed:", err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const domainEvent = mapStripeEventToDomain(event)
  if (!domainEvent) {
    return NextResponse.json({ received: true })
  }

  const supabase = createServiceSupabaseClient()

  try {
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await upsertSubscriptionFromStripe(event.data.object as any)
      return NextResponse.json({ received: true })
    }

    if (domainEvent.type === "payment_succeeded") {
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("provider_payment_id", domainEvent.provider_payment_id)
        .maybeSingle()

      if (!existing) {
        await recordPayment(
          {
            invoice_id: domainEvent.invoice_id,
            amount_cents: domainEvent.amount_cents,
            currency: domainEvent.currency,
            method: domainEvent.method as "ach" | "card" | "wire" | "check" | undefined,
            provider: "stripe",
            provider_payment_id: domainEvent.provider_payment_id,
            status: "succeeded",
            fee_cents: domainEvent.fee_cents,
            idempotency_key: domainEvent.provider_payment_id,
            metadata: domainEvent.metadata,
          },
          domainEvent.org_id,
        )

        await supabase.from("outbox").insert({
          org_id: domainEvent.org_id,
          job_type: "payment_succeeded",
          payload: domainEvent,
        })
      }
    }

    if (domainEvent.type === "payment_failed") {
      await supabase.from("payment_intents").update({ status: "failed" }).eq("provider_intent_id", domainEvent.provider_payment_id)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("Webhook processing error:", error)
    return NextResponse.json({ error: "Processing failed" }, { status: 500 })
  }
}
