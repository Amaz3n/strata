import { isInvoiceReceivableAsOf } from "@/lib/services/books/subledger-settlements"
import { isPayableVendorBillStatus } from "@/lib/financials/ledger-status"

type Invoice = { status: string | null; issue_date: string | null; metadata?: unknown }
function joinedInvoice(value: Invoice | Invoice[] | null) {
  if (!Array.isArray(value)) return value
  if (value.length > 1) throw new Error("Retainage has ambiguous invoice evidence")
  return value[0] ?? null
}

export function receivableRetainageAsOf(rows: Array<{ amount_cents: number | null; invoice: Invoice | Invoice[] | null; release: Invoice | Invoice[] | null }>, asOf: string) {
  return rows.reduce((sum, row) => {
    const invoice = joinedInvoice(row.invoice)
    const release = joinedInvoice(row.release)
    if (!invoice?.issue_date || invoice.issue_date > asOf || !isInvoiceReceivableAsOf(invoice, asOf)) return sum
    const released = release?.issue_date && release.issue_date <= asOf && isInvoiceReceivableAsOf(release, asOf)
    return sum + (released ? 0 : Number(row.amount_cents ?? 0))
  }, 0)
}

export function payableRetainageAsOf(rows: Array<{ status: string | null; bill_date: string | null; total_cents: number | null; retainage_cents: number | null; metadata?: unknown }>, asOf: string) {
  return rows.reduce((sum, row) => {
    if (!row.bill_date || row.bill_date > asOf || !isPayableVendorBillStatus(row.status)) return sum
    const isRelease = row.metadata && typeof row.metadata === "object" && Reflect.get(row.metadata, "source") === "retainage_release"
    return sum + (isRelease ? -Number(row.total_cents ?? 0) : Number(row.retainage_cents ?? 0))
  }, 0)
}
