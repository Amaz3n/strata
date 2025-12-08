"use server"

import { revalidatePath } from "next/cache"

import { createInvoice, ensureInvoiceToken, getInvoiceWithLines, listInvoiceViews, listInvoices } from "@/lib/services/invoices"
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

  return {
    invoice: { ...invoice, token },
    link: `${appUrl}/i/${token}`,
    views,
  }
}


