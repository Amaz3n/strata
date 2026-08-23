"use server"

import { createPublicInvoicePaymentIntent } from "@/lib/services/payments"
import { createPublicInvoicePaymentIntentInputSchema } from "@/lib/validation/payments"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function createPublicInvoicePaymentIntentAction(input: unknown) {
  const parsed = createPublicInvoicePaymentIntentInputSchema.parse(input)
  return createPublicInvoicePaymentIntent(parsed)
}

/**
 * Lightweight status check used after an online payment succeeds: the client polls
 * until the payment webhook has settled the invoice before reloading the page, so
 * the payer never sees a stale "unpaid" state right after being told it worked.
 */
export async function getPublicInvoiceStatusAction(token: string) {
  if (!token) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("invoices")
    .select("status, balance_due_cents, total_cents, client_visible")
    .eq("token", token)
    .maybeSingle()
  // Same gate as createPublicInvoicePaymentIntent: a token is only a credential
  // for invoices that were actually published, and never for voided ones.
  if (!data || data.client_visible !== true || data.status === "void") return null
  return {
    status: data.status as string,
    balanceDueCents: data.balance_due_cents ?? data.total_cents ?? 0,
  }
}
