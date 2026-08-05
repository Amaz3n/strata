import "server-only"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { assertDisbursementTransition } from "@/lib/payments/payment-domain"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The payout hold.
 *
 * Under destination charges the vendor transfer fired automatically the moment
 * the builder's debit cleared, so an ACH return arriving afterwards was money
 * already gone. Now the cleared funds sit on the platform balance for the org's
 * configured hold and only then become a transfer — a return inside the window
 * costs nothing, because no transfer was ever created.
 *
 * This is the second half of that design: the sweep that releases matured holds.
 */

/** One tick's worth of transfers. The rest wait for the next sweep. */
const TRANSFER_SWEEP_LIMIT = 100

interface MaturedTransferRow {
  disbursement_id: string
  org_id: string
  amount_cents: number
  currency: string
  provider_charge_id: string | null
  recipient_account_id: string | null
  run_id: string
}

export async function releaseMaturedVendorTransfers(): Promise<{
  attempted: number
  released: string[]
  failed: Array<{ disbursementId: string; error: string }>
}> {
  if (process.env.FINTECH_PAYMENTS_EXECUTION_ENABLED !== "true") {
    return { attempted: 0, released: [], failed: [] }
  }
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("claim_matured_vendor_transfers", { p_limit: TRANSFER_SWEEP_LIMIT })
  if (error) throw new Error(`Unable to claim matured vendor transfers: ${error.message}`)
  const rows = (data ?? []) as MaturedTransferRow[]

  const released: string[] = []
  const failed: Array<{ disbursementId: string; error: string }> = []
  for (const row of rows) {
    try {
      // Re-read the destination rather than trusting the claim: a payout account
      // put under a security hold between clearing and release must not be paid.
      const { data: recipient } = await supabase
        .from("payment_recipient_accounts")
        .select("id,provider,provider_account_id,status,payouts_enabled,destination_locked_until")
        .eq("id", row.recipient_account_id ?? "")
        .maybeSingle()
      if (!recipient || recipient.status !== "ready" || !recipient.payouts_enabled) {
        throw new Error("Vendor payout account is no longer ready")
      }
      if (recipient.destination_locked_until && new Date(recipient.destination_locked_until) > new Date()) {
        throw new Error("Vendor payout destination is in a security cooling period")
      }

      const provider = getPaymentRailProvider(recipient.provider)
      const result = await provider.createVendorTransfer({
        disbursementId: row.disbursement_id,
        orgId: row.org_id,
        amountCents: Number(row.amount_cents),
        currency: String(row.currency ?? "usd"),
        recipientProviderAccountId: recipient.provider_account_id,
        providerChargeId: row.provider_charge_id,
        transferGroup: `payment_run:${row.run_id}`,
        // Deterministic, so a retry after an ambiguous response reuses the same
        // key and the provider refuses to create a second transfer. On this rail
        // a duplicate is a vendor paid twice.
        idempotencyKey: `disbursement:${row.disbursement_id}:transfer`,
        metadata: { disbursement_id: row.disbursement_id, payment_run_id: row.run_id },
      })

      assertDisbursementTransition("funds_available", "transfer_pending")
      const { error: updateError } = await supabase
        .from("disbursements")
        .update({ status: "transfer_pending", provider_transfer_id: result.providerTransferId })
        .eq("org_id", row.org_id)
        .eq("id", row.disbursement_id)
        .eq("status", "funds_available")
      if (updateError) throw new Error(`Unable to record vendor transfer: ${updateError.message}`)
      released.push(row.disbursement_id)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Vendor transfer failed"
      // The disbursement stays `funds_available` so the next sweep retries it.
      // The builder's money has cleared to Arc and the vendor has not been paid,
      // which is a state a human has to know about rather than a retry loop.
      await supabase
        .from("disbursements")
        .update({ failure_reason: message })
        .eq("org_id", row.org_id)
        .eq("id", row.disbursement_id)
      await Promise.all([
        recordEvent({
          orgId: row.org_id,
          eventType: "vendor_transfer_needs_attention",
          entityType: "disbursement",
          entityId: row.disbursement_id,
          payload: { payment_run_id: row.run_id, amount_cents: row.amount_cents, error: message },
        }),
        recordAudit({
          orgId: row.org_id,
          action: "update",
          entityType: "disbursement",
          entityId: row.disbursement_id,
          after: { transfer_blocked: true, failure_reason: message },
          source: "cron",
        }),
      ])
      failed.push({ disbursementId: row.disbursement_id, error: message })
    }
  }
  return { attempted: rows.length, released, failed }
}
