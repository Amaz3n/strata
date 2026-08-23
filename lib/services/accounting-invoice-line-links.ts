import type { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface AccountingInvoiceLineLinkInput {
  invoiceLineId: string
  externalLineId?: string | null
  externalItemId: string
  externalItemName?: string | null
  externalIncomeAccountId?: string | null
  externalIncomeAccountName?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Persist the provider identity of every invoice line separately from Arc's
 * revenue-account coding. Callers pass an authenticated/service Supabase client
 * so authorization remains owned by the calling workflow.
 */
export async function persistAccountingInvoiceLineLinks(input: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId: string
  provider: string
  invoiceId: string
  externalInvoiceId: string
  lines: AccountingInvoiceLineLinkInput[]
}) {
  if (input.lines.length === 0) return
  const { error } = await input.supabase.from("accounting_invoice_line_links").upsert(
    input.lines.map((line) => ({
      org_id: input.orgId,
      connection_id: input.connectionId,
      provider: input.provider,
      invoice_id: input.invoiceId,
      invoice_line_id: line.invoiceLineId,
      external_invoice_id: input.externalInvoiceId,
      external_line_id: line.externalLineId ?? null,
      external_item_id: line.externalItemId,
      external_item_name: line.externalItemName ?? null,
      external_income_account_id: line.externalIncomeAccountId ?? null,
      external_income_account_name: line.externalIncomeAccountName ?? null,
      metadata: line.metadata ?? {},
    })),
    { onConflict: "org_id,connection_id,invoice_line_id" },
  )
  if (error) throw new Error(`Unable to persist accounting invoice-line links: ${error.message}`)
}
