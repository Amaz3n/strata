import { NextRequest, NextResponse } from "next/server"
import Stripe from "stripe"

import {
  constructWebhookEvent,
  mapStripeEventToDomain,
  retrieveStripeSubscription,
  retrieveStripeChargeWithBalanceTransaction,
} from "@/lib/integrations/payments/stripe"
import { recordPayment, recordPaymentReversal, resolvePaymentReversal } from "@/lib/services/payments"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { upsertSubscriptionFromStripe } from "@/lib/services/subscriptions"
import { authorize } from "@/lib/services/authorization"
import { logger } from "@/lib/logging/logger"
import { syncStripeConnectedAccountFromStripeAccount } from "@/lib/services/stripe-connected-accounts"
import { processStripeApEvent } from "@/lib/services/payment-provider-events"

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
    logger.warn("stripe.webhook.signature_verification_failed", {
      domain: "stripe",
      integration: "stripe",
      error: err,
    })
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const supabase = createServiceSupabaseClient()
  let orgId = resolveOrgIdFromEvent(event)
  if (!orgId && typeof event.account === "string") {
    const { data: connection } = await supabase
      .from("stripe_connected_accounts")
      .select("org_id")
      .eq("stripe_account_id", event.account)
      .maybeSingle()
    orgId = connection?.org_id ?? null
  }

  // The unique index on (provider, provider_event_id) is the arbiter, not a
  // prior SELECT. Two concurrent deliveries of the same event both read "no
  // row", both inserted, and the loser's 23505 surfaced as a processing failure
  // that made Stripe retry an event already recorded. Claim the row first, then
  // read back what is actually there to decide whether it is already handled.
  const { error: claimError } = await supabase.from("webhook_events").insert({
    org_id: orgId,
    provider: "stripe",
    provider_event_id: event.id,
    event_type: event.type,
    payload: event as unknown as Record<string, any>,
  })
  if (claimError && (claimError as { code?: string }).code !== "23505") {
    logger.error("stripe.webhook.record_failed", {
      domain: "stripe",
      integration: "stripe",
      eventId: event.id,
      error: claimError,
    })
    return NextResponse.json({ error: "Processing failed" }, { status: 500 })
  }
  if (claimError) {
    const { data: existingWebhookEvent } = await supabase
      .from("webhook_events")
      .select("processed_at, status")
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id)
      .maybeSingle()
    if (existingWebhookEvent?.processed_at || existingWebhookEvent?.status === "processed") {
      return NextResponse.json({ received: true, duplicate: true })
    }
  }

  const domainEvent = mapStripeEventToDomain(event)

  try {
    const apResult = await processStripeApEvent(event)
    if (apResult.handled) {
      await supabase
        .from("webhook_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("provider", "stripe")
        .eq("provider_event_id", event.id)
      return NextResponse.json({ received: true, duplicate: apResult.duplicate ?? false })
    }

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

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id

      if (subscriptionId) {
        const subscription = await retrieveStripeSubscription(subscriptionId)
        await upsertSubscriptionFromStripe(subscription as any)
      }

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

    if (domainEvent.type === "payment_succeeded" || domainEvent.type === "payment_processing") {
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
          logger.warn("stripe.webhook.payment_side_effect_denied", {
            domain: "stripe",
            integration: "stripe",
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

      await recordPayment(
          {
            invoice_id: domainEvent.invoice_id,
            amount_cents: domainEvent.amount_cents,
            currency: domainEvent.currency,
            method: domainEvent.method as "ach" | "card" | "wire" | "check" | undefined,
            provider: "stripe",
            provider_payment_id: domainEvent.provider_payment_id,
            status: domainEvent.type === "payment_processing" ? "processing" : "succeeded",
            fee_cents: domainEvent.fee_cents,
            idempotency_key: domainEvent.provider_payment_id,
            metadata: domainEvent.metadata,
          },
          domainEvent.org_id,
        )

    }

    if (domainEvent.type === "payment_reversed") {
      const reversalOrgId =
        orgId ??
        (typeof domainEvent.metadata?.org_id === "string" ? domainEvent.metadata.org_id : null)
      if (!reversalOrgId) {
        throw new Error("Stripe reversal is missing organization metadata")
      }
      await recordPaymentReversal({
        orgId: reversalOrgId,
        providerPaymentId: domainEvent.provider_payment_id,
        providerChargeId: domainEvent.provider_charge_id,
        amountCents: domainEvent.amount_cents,
        reversalType: domainEvent.reversal_type,
        providerReversalId: domainEvent.provider_reversal_id,
        reason: domainEvent.reason,
        metadata: domainEvent.metadata ?? undefined,
      })
    }

    if (domainEvent.type === "payment_reversal_resolved") {
      const reversalOrgId =
        orgId ??
        (typeof domainEvent.metadata?.org_id === "string" ? domainEvent.metadata.org_id : null)
      if (!reversalOrgId) {
        throw new Error("Stripe reversal resolution is missing organization metadata")
      }
      await resolvePaymentReversal({
        orgId: reversalOrgId,
        providerReversalId: domainEvent.provider_reversal_id,
        outcome: domainEvent.outcome,
        reason: domainEvent.reason,
        metadata: domainEvent.metadata ?? undefined,
      })
    }

    if (event.type === "charge.succeeded") {
      const chargeEvent = event.data.object as Stripe.Charge
      const eventConnectedAccountId = typeof event.account === "string" && event.account.length > 0 ? event.account : null
      const charge = await retrieveStripeChargeWithBalanceTransaction(chargeEvent.id, eventConnectedAccountId)
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
        eventConnectedAccountId ?? (typeof charge.transfer_data?.destination === "string" ? charge.transfer_data.destination : null)

      // Resolve the owning org before writing anything. `charge.succeeded`
      // frequently carries no org metadata, and an unscoped service-role UPDATE
      // is the one shape that could ever cross a tenant boundary. If the charge
      // cannot be attributed it is left alone rather than written blind.
      const { data: intentRow } = paymentIntentId
        ? await supabase.from("payment_intents").select("org_id").eq("provider_intent_id", paymentIntentId).maybeSingle()
        : { data: null }
      const { data: paymentRow } = paymentIntentId
        ? await supabase.from("payments").select("org_id").eq("provider_payment_id", paymentIntentId).maybeSingle()
        : { data: null }
      const chargeOrgId = orgId ?? intentRow?.org_id ?? paymentRow?.org_id ?? null
      if (!chargeOrgId) {
        logger.warn("stripe.webhook.charge_without_org", {
          domain: "stripe",
          integration: "stripe",
          eventId: event.id,
          chargeId: charge.id,
        })
      } else {
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
          .eq("org_id", chargeOrgId)
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
          .eq("org_id", chargeOrgId)
          .eq("provider_payment_id", paymentIntentId)
      }
    }

    if (domainEvent.type === "payment_failed") {
      const failedOrgId = orgId ?? (typeof domainEvent.metadata?.org_id === "string" ? domainEvent.metadata.org_id : null)
      let failedIntents = supabase.from("payment_intents").update({ status: "failed" }).eq("provider_intent_id", domainEvent.provider_payment_id)
      if (failedOrgId) failedIntents = failedIntents.eq("org_id", failedOrgId)
      await failedIntents
      await supabase
        .from("invoice_payment_reservations")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("provider_intent_id", domainEvent.provider_payment_id)
        .eq("status", "active")
      const { data: failedPayment } = await supabase
        .from("payments")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("provider_payment_id", domainEvent.provider_payment_id)
        .select("org_id,invoice_id")
        .maybeSingle()
      if (failedPayment?.org_id && failedPayment.invoice_id) {
        await supabase.rpc("recalc_invoice_balance_atomic", {
          p_org_id: failedPayment.org_id,
          p_invoice_id: failedPayment.invoice_id,
        })
      }
    }

    await supabase
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id)

    return NextResponse.json({ received: true })
  } catch (error) {
    logger.error("stripe.webhook.processing_failed", {
      domain: "stripe",
      integration: "stripe",
      orgId,
      eventId: event.id,
      eventType: event.type,
      connectedAccountId: typeof event.account === "string" ? event.account : undefined,
      error,
    })
    await supabase
      .from("webhook_events")
      .update({ status: "failed" })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id)
    return NextResponse.json({ error: "Processing failed" }, { status: 500 })
  }
}
