import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Invoice balance/status derivation lives in ONE place: the SQL functions
 * invoice_paid_cents + derive_invoice_status (see migration
 * 20260715100001_unify_invoice_status_engine.sql). The payment RPCs and this
 * recalc all call the same functions, so an invoice's status can never depend
 * on which write path last touched it.
 */
export async function recalcInvoiceBalanceAndStatus({
  supabase,
  orgId,
  invoiceId,
}: {
  supabase: SupabaseClient
  orgId: string
  invoiceId: string
}) {
  const { data, error } = await supabase.rpc("recalc_invoice_balance_atomic", {
    p_org_id: orgId,
    p_invoice_id: invoiceId,
  })
  if (error) {
    throw new Error(`Failed to recalc invoice balance: ${error.message}`)
  }
  const result = data as { balance_due_cents: number; status: string; paid_cents: number }
  await syncDrawStatusForInvoice({ supabase, orgId, invoiceId, invoiceStatus: result.status })
  return result
}

export async function syncDrawStatusForInvoice({
  supabase,
  orgId,
  invoiceId,
  invoiceStatus,
}: {
  supabase: SupabaseClient
  orgId: string
  invoiceId: string
  invoiceStatus: string
}) {
  try {
    const { data: draws, error } = await supabase
      .from("draw_schedules")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)

    if (error || !draws || draws.length === 0) return
    const drawIds = (draws as Array<{ id: string }>).map((draw) => draw.id)

    if (invoiceStatus === "paid") {
      await supabase
        .from("draw_schedules")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .in("id", drawIds)
      return
    }

    if (invoiceStatus === "partial") {
      await supabase.from("draw_schedules").update({ status: "partial" }).eq("org_id", orgId).in("id", drawIds)
      return
    }

    if (invoiceStatus === "sent" || invoiceStatus === "overdue") {
      await supabase.from("draw_schedules").update({ status: "invoiced" }).eq("org_id", orgId).in("id", drawIds)
      return
    }

    if (invoiceStatus === "void") {
      await supabase
        .from("draw_schedules")
        .update({ invoice_id: null, status: "pending", invoiced_at: null, paid_at: null })
        .eq("org_id", orgId)
        .in("id", drawIds)
    }
  } catch (err) {
    console.warn("Failed to sync draw status for invoice", err)
  }
}
