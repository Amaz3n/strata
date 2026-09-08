import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"

/** Trusted ownership comes from posted import rows, never an editable source flag. */
export async function loadOpeningOwnedSources(orgId: string) {
  const service = createServiceSupabaseClient()
  const rows = await collectBooksRows((from,to) => service.from("opening_balance_lines")
    .select("operational_entity_type,operational_entity_id,operational_payment_id,batch:opening_balance_batches!inner(status)")
    .eq("org_id",orgId).eq("batch.status","posted").not("operational_entity_id","is",null).order("id").range(from,to))
  const invoices = new Set<string>(), bills = new Set<string>(), payments = new Set<string>()
  for (const row of rows) {
    if (row.operational_entity_type === "invoice" || row.operational_entity_type === "deposit_invoice") invoices.add(String(row.operational_entity_id))
    if (row.operational_entity_type === "vendor_bill") bills.add(String(row.operational_entity_id))
    if (row.operational_payment_id) payments.add(String(row.operational_payment_id))
  }
  return { invoices, bills, payments }
}
