import "server-only"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { assertDisbursementTransition } from "@/lib/payments/payment-domain"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import { assertPaymentLaunchReady } from "@/lib/services/payment-launch-readiness"
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
const EXECUTION_FLAG = "fintech_ap_payments"

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
  await assertPaymentLaunchReady()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("claim_matured_vendor_transfers", { p_limit: TRANSFER_SWEEP_LIMIT })
  if (error) throw new Error(`Unable to claim matured vendor transfers: ${error.message}`)
  const rows = (data ?? []) as MaturedTransferRow[]

  // The memo follows the payable into the provider transfer. It is read only
  // after the claim has fixed the disbursement set, and never affects routing,
  // amount, or destination authority.
  const disbursementIds = rows.map((row) => row.disbursement_id)
  const { data: disbursementItems } = disbursementIds.length > 0
    ? await supabase.from("disbursements").select("id,run_item_id").in("id", disbursementIds)
    : { data: [] }
  const runItemIds = (disbursementItems ?? []).map((row) => row.run_item_id).filter(Boolean)
  const { data: runItems } = runItemIds.length > 0
    ? await supabase.from("payment_run_items").select("id,bill_id").in("id", runItemIds)
    : { data: [] }
  const billIds = (runItems ?? []).map((row) => row.bill_id).filter(Boolean)
  const { data: bills } = billIds.length > 0
    ? await supabase.from("vendor_bills").select("id,metadata").in("id", billIds)
    : { data: [] }
  const billByRunItem = new Map((runItems ?? []).map((item) => [item.id, item.bill_id]))
  const runItemByDisbursement = new Map((disbursementItems ?? []).map((item) => [item.id, item.run_item_id]))
  const memoByBill = new Map((bills ?? []).map((bill) => {
    const memo = bill.metadata && typeof bill.metadata === "object" && !Array.isArray(bill.metadata)
      ? Reflect.get(bill.metadata, "payment_memo")
      : null
    return [bill.id, typeof memo === "string" ? memo.slice(0, 140) : ""]
  }))

  // Which orgs still have the rail armed. The env switch alone is a platform
  // control and says nothing about one builder.
  const orgIds = [...new Set(rows.map((row) => row.org_id))]
  const { data: policies, error: policyError } = orgIds.length > 0
    ? await supabase.from("payment_rail_policies").select("org_id,enabled").in("org_id", orgIds)
    : { data: [], error: null }
  if (policyError) throw new Error(`Unable to load payment policies for transfer release: ${policyError.message}`)
  const railEnabledByOrg = new Map((policies ?? []).map((policy) => [policy.org_id, Boolean(policy.enabled)]))
  const flagEntries = await Promise.all(
    orgIds.map(async (orgId) => [
      orgId,
      await isFeatureEnabledForOrg({ supabase, orgId, flagKey: EXECUTION_FLAG, defaultEnabled: false }),
    ] as const),
  )
  const executionEnabledByOrg = new Map(flagEntries)

  const released: string[] = []
  const failed: Array<{ disbursementId: string; error: string }> = []
  for (const row of rows) {
    try {
      // DECISION — money already debited does NOT complete while an org's rail
      // is disabled. Disabling is an explicit control action and the likeliest
      // reason to take it is suspected compromise, which is exactly when the
      // remaining irreversible step must not fire. Holding is recoverable: the
      // funds sit on the platform balance, the disbursement stays
      // `funds_available`, and re-enabling the rail lets the next sweep complete
      // it. Transferring is not recoverable. The vendor waiting is a real cost,
      // which is why this is loud rather than silent — it opens a durable
      // incident and notifies when that incident first opens or reopens.
      if (!executionEnabledByOrg.get(row.org_id)) {
        throw new Error("This organization's AP payment feature is disabled; the cleared funds are held until it is re-enabled")
      }
      if (!railEnabledByOrg.get(row.org_id)) {
        throw new Error("This organization's Arc Pay is disabled; the cleared funds are held until it is re-enabled")
      }
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
      const runItemId = runItemByDisbursement.get(row.disbursement_id)
      const billId = runItemId ? billByRunItem.get(runItemId) : null
      const paymentMemo = billId ? memoByBill.get(billId) : ""
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
        memo: paymentMemo || undefined,
        metadata: { disbursement_id: row.disbursement_id, payment_run_id: row.run_id, ...(paymentMemo ? { payment_memo: paymentMemo } : {}) },
      })

      assertDisbursementTransition("funds_available", "transfer_pending")
      const { error: updateError } = await supabase
        .from("disbursements")
        .update({ status: "transfer_pending", provider_transfer_id: result.providerTransferId })
        .eq("org_id", row.org_id)
        .eq("id", row.disbursement_id)
        .eq("status", "funds_available")
      if (updateError) throw new Error(`Unable to record vendor transfer: ${updateError.message}`)
      await supabase.rpc("resolve_payment_operations_incident", {
        p_org_id: row.org_id,
        p_finding_code: `vendor_transfer_blocked:${row.disbursement_id}`,
      })
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
      const { data: shouldNotify, error: incidentError } = await supabase.rpc("open_payment_operations_incident", {
        p_org_id: row.org_id,
        p_finding_code: `vendor_transfer_blocked:${row.disbursement_id}`,
        p_detail: message,
      })
      if (incidentError) throw new Error(`Unable to open vendor transfer incident: ${incidentError.message}`)
      await Promise.all([
        shouldNotify
          ? recordEvent({
              orgId: row.org_id,
              eventType: "vendor_transfer_needs_attention",
              entityType: "disbursement",
              entityId: row.disbursement_id,
              payload: { payment_run_id: row.run_id, amount_cents: row.amount_cents, error: message },
            })
          : Promise.resolve(),
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
