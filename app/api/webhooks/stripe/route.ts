import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"

import {
  constructWebhookEvent,
  mapStripeEventToDomain,
  retrieveStripeChargeWithBalanceTransaction,
} from "@/lib/integrations/payments/stripe"
import { recordPayment } from "@/lib/services/payments"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { upsertSubscriptionFromStripe } from "@/lib/services/subscriptions"
import { authorize } from "@/lib/services/authorization"
import { syncStripeConnectedAccountFromStripeAccount } from "@/lib/services/stripe-connected-accounts"

function resolveActorUserId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined
  }

  const candidate = metadata as Record<string, unknown>
  const value = candidate.actor_user_id ?? candidate.actorUserId ?? candidate.user_id ?? candidate.userId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resolveOrgIdFromEvent(event: Stripe.Event): string | null {
  const object = event.data.object as Record<string, any> | null
  if (!object) return null

  const metadata = object.metadata as Record<string, unknown> | undefined
  if (typeof metadata?.org_id === "string" && metadata.org_id.length > 0) {
    return metadata.org_id
  }
  if (typeof object.org_id === "string" && object.org_id.length > 0) {
    return object.org_id
  }
  return null
}

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

  const supabase = createServiceSupabaseClient()
  const orgId = resolveOrgIdFromEvent(event)

  const { data: existingWebhookEvent } = await supabase
    .from("webhook_events")
    .select("id, processed_at, status")
    .eq("provider", "stripe")
    .eq("provider_event_id", event.id)
    .maybeSingle()

  if (existingWebhookEvent?.processed_at || existingWebhookEvent?.status === "processed") {
    return NextResponse.json({ received: true, duplicate: true })
  }

  if (!existingWebhookEvent) {
    await supabase.from("webhook_events").insert({
      org_id: orgId,
      provider: "stripe",
      provider_event_id: event.id,
      event_type: event.type,
      payload: event as unknown as Record<string, any>,
    })
  }

  const domainEvent = mapStripeEventToDomain(event)

  try {
    if (event.type === "account.updated") {
      await syncStripeConnectedAccountFromStripeAccount(event.data.object as Stripe.Account)
      await supabase
        .from("webhook_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("provider", "stripe")
        .eq("provider_event_id", event.id)
      return NextResponse.json({ received: true })
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await upsertSubscriptionFromStripe(event.data.object as any)
      await supabase
        .from("webhook_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("provider", "stripe")
        .eq("provider_event_id", event.id)
      return NextResponse.json({ received: true })
    }

    if (!domainEvent) {
      await supabase
        .from("webhook_events")
        .update({ status: "ignored", processed_at: new Date().toISOString() })
        .eq("provider", "stripe")
        .eq("provider_event_id", event.id)
      return NextResponse.json({ received: true })
    }

    if (domainEvent.type === "payment_succeeded") {
      const actorUserId = resolveActorUserId(domainEvent.metadata)
      if (actorUserId && domainEvent.org_id) {
        const decision = await authorize({
          permission: "payment.release",
          userId: actorUserId,
          orgId: domainEvent.org_id,
          supabase,
          logDecision: true,
          resourceType: "invoice",
          resourceId: domainEvent.invoice_id,
          requestId: event.id,
          policyVersion: "phase3-webhook-v1",
        })

        if (!decision.allowed) {
          console.warn("Stripe webhook skipped payment side-effect due to authorization denial", {
            eventId: event.id,
            actorUserId,
            orgId: domainEvent.org_id,
            invoiceId: domainEvent.invoice_id,
            reasonCode: decision.reasonCode,
          })
          await supabase
            .from("webhook_events")
            .update({ status: "ignored", processed_at: new Date().toISOString() })
            .eq("provider", "stripe")
            .eq("provider_event_id", event.id)
          return NextResponse.json({ received: true, skipped: true })
        }
      }

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

    if (event.type === "charge.succeeded") {
      const chargeEvent = event.data.object as Stripe.Charge
      const charge = await retrieveStripeChargeWithBalanceTransaction(chargeEvent.id)
      const balanceTransaction =
        charge.balance_transaction && typeof charge.balance_transaction !== "string"
          ? charge.balance_transaction
          : null
      const processorFeeCents = balanceTransaction?.fee ?? 0
      const applicationFeeCents = charge.application_fee_amount ?? 0
      const grossCents = charge.amount ?? 0
      const totalFeeCents = processorFeeCents + applicationFeeCents
      const netCents = grossCents - totalFeeCents
      const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id
      const transferId = typeof charge.transfer === "string" ? charge.transfer : null
      const connectedAccountId =
        typeof charge.transfer_data?.destination === "string" ? charge.transfer_data.destination : null

      await supabase
        .from("payment_intents")
        .update({
          provider_charge_id: charge.id,
          provider_transfer_id: transferId,
          connected_account_id: connectedAccountId,
          processor_fee_cents: processorFeeCents,
          platform_fee_cents: applicationFeeCents,
          application_fee_amount: applicationFeeCents,
          status: charge.status ?? undefined,
        })
        .eq("provider_intent_id", paymentIntentId)

      await supabase
        .from("payments")
        .update({
          provider_charge_id: charge.id,
          provider_balance_transaction_id: balanceTransaction?.id ?? null,
          provider_transfer_id: transferId,
          connected_account_id: connectedAccountId,
          gross_cents: grossCents,
          fee_cents: totalFeeCents,
          processor_fee_cents: processorFeeCents,
          platform_fee_cents: applicationFeeCents,
          application_fee_cents: applicationFeeCents,
          net_cents: netCents,
        })
        .eq("provider_payment_id", paymentIntentId)
    }

    if (domainEvent.type === "payment_failed") {
      await supabase.from("payment_intents").update({ status: "failed" }).eq("provider_intent_id", domainEvent.provider_payment_id)
    }

    await supabase
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id)

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("Webhook processing error:", error)
    await supabase
      .from("webhook_events")
      .update({ status: "failed" })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id)
    return NextResponse.json({ error: "Processing failed" }, { status: 500 })
  }
}
