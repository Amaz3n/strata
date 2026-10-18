import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { z } from "zod"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import type { InvoiceRevenueLine } from "@/lib/services/books/invoice-revenue-rules"

/** Read the saved native chart selection, never a disconnected provider's account ID. */
export async function loadInvoiceRevenueLines(orgId: string, invoiceIds: string[]) {
  const service = createServiceSupabaseClient()
  const result = new Map<string, InvoiceRevenueLine[]>()
  const errors = new Map<string, string>()
  const sourceVersions = new Map<string, string>()
  const ids = [...new Set(invoiceIds)].sort()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const { data, error } = await service.rpc("books_invoice_income_evidence" as never, { p_org_id: orgId, p_invoice_ids: batch } as never)
    if (error) throw new Error(`Failed to capture invoice income evidence: ${error.message}`)
    const invoices = evidenceSchema.parse(data)
    for (const id of batch) if (!invoices.some(invoice => invoice.id === id)) errors.set(id, "Invoice income evidence is missing from this organization")
    for (const invoice of invoices) {
      if (!batch.includes(invoice.id)) throw new Error("Invoice income evidence returned an unrequested document")
      sourceVersions.set(invoice.id, invoice.updated_at)
      for (const row of invoice.lines) {
        const metadata = row.metadata as Record<string, unknown> | null
        if (metadata?.system_generated_kind === "retainage_hold") continue
        const selectedId = typeof metadata?.arc_books_gl_account_id === "string" ? metadata.arc_books_gl_account_id : null
        const account = row.selected_account
        if (selectedId && (!account || account.id !== selectedId || account.account_type !== "income")) {
          errors.set(invoice.id, "The invoice income account does not belong to this organization's income chart")
          continue
        }
        const cents = Math.round(Number(row.quantity) * Number(row.unit_price_cents ?? 0))
        if (!Number.isSafeInteger(cents)) { errors.set(invoice.id, "Invoice revenue must use integer cents"); continue }
        if (!cents) continue
        const lines = result.get(invoice.id) ?? []
        lines.push({ account_code: account?.code ?? SYSTEM_ACCOUNT_CODES.constructionRevenue, amount_cents: cents,
          ...(row.cost_code_id ? { dimensions: { cost_code_id: row.cost_code_id } } : {}) })
        result.set(invoice.id, lines)
      }
    }
  }
  return { lines: result, errors, sourceVersions }
}

const evidenceSchema = z.array(z.object({
  id: z.string().uuid(), updated_at: z.string(),
  lines: z.array(z.object({
    id: z.string().uuid(), quantity: z.string().nullable(), unit_price_cents: z.number().int().nullable(),
    cost_code_id: z.string().uuid().nullable(), metadata: z.record(z.unknown()).nullable(),
    selected_account: z.object({ id: z.string().uuid(), code: z.string(), account_type: z.string(), active: z.boolean() }).nullable(),
  })),
}))
