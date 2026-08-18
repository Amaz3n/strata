"use server"

import { revalidatePath } from "next/cache"

import {
  dailyReconciliationPeriod,
  resolvePaymentReconciliationItem,
  runPaymentReconciliation,
} from "@/lib/services/payment-reconciliation"

/**
 * The same closed UTC day the cron reconciles, not a rolling window ending now.
 * Two period conventions in one table meant a manual run and the scheduled run
 * could never be compared — or deduplicated — against each other.
 */
export async function reconcileVendorPaymentsAction() {
  await runPaymentReconciliation(dailyReconciliationPeriod())
  revalidatePath("/payables/reconciliation")
}

export async function resolveVendorPaymentExceptionAction(formData: FormData) {
  const itemId = String(formData.get("item_id") ?? "")
  const note = String(formData.get("note") ?? "")
  const reference = String(formData.get("reference") ?? "")
  const evidenceSource = String(formData.get("evidence_source") ?? "") as "provider" | "bank" | "accounting" | "ledger" | "other"
  await resolvePaymentReconciliationItem({ itemId, note, reference, evidenceSource })
  revalidatePath("/payables/reconciliation")
}
