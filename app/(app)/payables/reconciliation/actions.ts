"use server"

import { revalidatePath } from "next/cache"

import { resolvePaymentReconciliationItem, runPaymentReconciliation } from "@/lib/services/payment-reconciliation"

export async function reconcileVendorPaymentsAction() {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
  await runPaymentReconciliation({ period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() })
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
