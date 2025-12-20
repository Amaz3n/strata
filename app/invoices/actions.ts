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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://app.strata.build"

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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://app.strata.build"
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
