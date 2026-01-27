"use server"

import { revalidatePath } from "next/cache"

import {
  createInvoice,
  ensureInvoiceToken,
  getInvoiceWithLines,
  listInvoiceViews,
  listInvoices,
  updateInvoice,
} from "@/lib/services/invoices"
import { enqueueInvoiceSync, syncInvoiceToQBO } from "@/lib/services/qbo-sync"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { sendReminderEmail } from "@/lib/services/mailer"

export async function listInvoicesAction(projectId?: string) {
  return listInvoices({ projectId })
}

export async function createInvoiceAction(input: unknown) {
  const parsed = invoiceInputSchema.parse(input)
  const invoice = await createInvoice({ input: parsed })
  revalidatePath("/invoices")
  return invoice
}

export async function updateInvoiceAction(invoiceId: string, input: unknown) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const parsed = invoiceInputSchema.parse(input)
  const invoice = await updateInvoice({ invoiceId, input: parsed })
  revalidatePath("/invoices")
  return invoice
}

export async function generateInvoiceLinkAction(invoiceId: string) {
  if (!invoiceId) {
    throw new Error("Invoice id is required")
  }

  const token = await ensureInvoiceToken(invoiceId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

  return {
    token,
    url: `${appUrl}/i/${token}`,
  }
}

export async function getInvoiceDetailAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const invoice = await getInvoiceWithLines(invoiceId)
  if (!invoice) throw new Error("Invoice not found")

  const token = await ensureInvoiceToken(invoiceId, invoice.org_id)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const views = await listInvoiceViews(invoiceId, invoice.org_id)
  const supabase = createServiceSupabaseClient()
  const { data: syncHistory } = await supabase
    .from("qbo_sync_records")
    .select("id, status, last_synced_at, error_message, qbo_id")
    .eq("org_id", invoice.org_id)
    .eq("entity_type", "invoice")
    .eq("entity_id", invoiceId)
    .order("last_synced_at", { ascending: false })

  return {
    invoice: { ...invoice, token },
    link: `${appUrl}/i/${token}`,
    views,
    syncHistory: syncHistory ?? [],
  }
}

export async function manualResyncInvoiceAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const { orgId } = await requireOrgContext()
  await enqueueInvoiceSync(invoiceId, orgId)
  revalidatePath("/invoices")
  return { success: true }
}

export async function syncPendingInvoicesNowAction(limit = 15) {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()

  const { data: pending } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_sync_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit)

  if (!pending?.length) {
    revalidatePath("/invoices")
    return { success: true, processed: 0 }
  }

  let processed = 0
  for (const row of pending) {
    const result = await syncInvoiceToQBO(row.id, orgId)
    if (result.success) processed++
  }

  revalidatePath("/invoices")
  return { success: true, processed }
}

export async function sendInvoiceReminderAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const { orgId } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(invoiceId, orgId)

  if (!invoice) throw new Error("Invoice not found")
  if (invoice.status === "paid" || invoice.status === "void") {
    throw new Error("Cannot send reminder for paid or void invoices")
  }

  // Get recipient email from sent_to_emails or metadata
  const recipientEmail = invoice.sent_to_emails?.[0] ?? (invoice.metadata as any)?.customer_email
  if (!recipientEmail) {
    throw new Error("No recipient email found for this invoice")
  }

  const token = await ensureInvoiceToken(invoiceId, orgId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const payLink = `${appUrl}/i/${token}`

  // Calculate days overdue if applicable
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : null
  const now = new Date()
  let daysOverdue: number | undefined
  if (dueDate && now > dueDate) {
    daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  await sendReminderEmail({
    to: recipientEmail,
    recipientName: (invoice.metadata as any)?.customer_name ?? null,
    invoiceNumber: invoice.invoice_number,
    amountDue: invoice.balance_due_cents ?? invoice.total_cents ?? 0,
    dueDate: invoice.due_date ?? new Date().toISOString(),
    daysOverdue,
    payLink,
  })

  return { success: true }
}
