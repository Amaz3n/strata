import type { SupabaseClient } from "@supabase/supabase-js"

type InvoiceRow = {
  id: string
  org_id: string
  project_id: string | null
  total_cents: number | null
  due_date: string | null
  status: string | null
  client_visible: boolean | null
  sent_at: string | null
}

type PaymentRow = {
  amount_cents: number | null
  status: string | null
}

function isOverdue(dueDate: string | null | undefined) {
  if (!dueDate) return false
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return false
  return due.getTime() < Date.now()
}

export async function recalcInvoiceBalanceAndStatus({
  supabase,
  orgId,
  invoiceId,
}: {
  supabase: SupabaseClient
  orgId: string
  invoiceId: string
}) {
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, total_cents, due_date, status, client_visible, sent_at")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (invoiceError || !invoice) {
    throw new Error(invoiceError?.message ?? "Invoice not found or inaccessible")
  }

  const { data: paymentRows, error: paymentError } = await supabase
    .from("payments")
    .select("amount_cents, status")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .in("status", ["succeeded", "processing"])
    .returns<PaymentRow[]>()

  if (paymentError) {
    throw new Error(`Failed to aggregate payments: ${paymentError.message}`)
  }

  const invoiceRow = invoice as unknown as InvoiceRow
  const paidCents = (paymentRows ?? []).reduce((sum, row) => sum + (row.amount_cents ?? 0), 0)
  const totalCents = invoiceRow.total_cents ?? 0

  const currentStatus = invoiceRow.status ?? "sent"
  if (currentStatus === "void") {
    await supabase
      .from("invoices")
      .update({ balance_due_cents: 0, status: "void" })
      .eq("id", invoiceId)
      .eq("org_id", orgId)
    await syncDrawStatusForInvoice({ supabase, orgId, invoiceId, invoiceStatus: "void" })
    return { balance_due_cents: 0, status: "void" as const, paid_cents: paidCents }
  }

  const nextBalance = Math.max(totalCents - paidCents, 0)

  let nextStatus: string
  if (totalCents > 0 && nextBalance === 0) {
    nextStatus = "paid"
  } else if (currentStatus === "draft" && paidCents === 0 && !(invoiceRow.client_visible || invoiceRow.sent_at)) {
    nextStatus = "draft"
  } else if (paidCents > 0 && nextBalance > 0) {
    nextStatus = "partial"
  } else if (isOverdue(invoiceRow.due_date) && nextBalance > 0) {
    nextStatus = "overdue"
  } else {
    nextStatus = "sent"
  }

  const { error: updateError } = await supabase
    .from("invoices")
    .update({ balance_due_cents: nextBalance, status: nextStatus })
    .eq("id", invoiceId)
    .eq("org_id", orgId)

  if (updateError) {
    throw new Error(`Failed to update invoice balance: ${updateError.message}`)
  }

  await syncDrawStatusForInvoice({ supabase, orgId, invoiceId, invoiceStatus: nextStatus })

  return { balance_due_cents: nextBalance, status: nextStatus, paid_cents: paidCents }
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
    const { data: draw, error } = await supabase
      .from("draw_schedules")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .maybeSingle()

    if (error || !draw) return
    const drawRow = draw as unknown as { id: string; status: string }

    if (invoiceStatus === "paid") {
      await supabase
        .from("draw_schedules")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", drawRow.id)
        .eq("org_id", orgId)
      return
    }

    if (invoiceStatus === "partial") {
      await supabase.from("draw_schedules").update({ status: "partial" }).eq("id", drawRow.id).eq("org_id", orgId)
      return
    }

    if (invoiceStatus === "sent" || invoiceStatus === "overdue") {
      await supabase.from("draw_schedules").update({ status: "invoiced" }).eq("id", drawRow.id).eq("org_id", orgId)
    }
  } catch (err) {
    console.warn("Failed to sync draw status for invoice", err)
  }
}
