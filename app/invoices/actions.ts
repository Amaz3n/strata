"use server"

import { revalidatePath } from "next/cache"

import { createInvoice, listInvoices } from "@/lib/services/invoices"
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
