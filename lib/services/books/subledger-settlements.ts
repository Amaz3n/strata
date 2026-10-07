import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES, POSTED_PAYMENT_STATUSES } from "@/lib/financials/ledger-status"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { chunk } from "@/lib/utils"
import { collectBooksRows } from "@/lib/services/books/paging"

type Client = ReturnType<typeof createServiceSupabaseClient>

export function accountingCutoff(asOf: string) {
  const date = new Date(`${asOf}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) throw new Error("Invalid accounting date")
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString()
}

/** Dated settlement evidence shared by aging and ledger controls. Never use lifetime paid totals. */
export async function loadSubledgerSettlements(client: Client, orgId: string, side: "receivable" | "payable", documentIds: string[], asOf: string) {
  const cutoff = accountingCutoff(asOf)
  const key = side === "receivable" ? "invoice_id" : "bill_id"
  const totals = new Map<string, number>()
  const add = (id: string, amount: unknown, direction = 1) => {
    const cents = Number(amount ?? 0)
    if (!Number.isSafeInteger(cents)) throw new Error("Settlement amount must use integer cents")
    const total = (totals.get(id) ?? 0) + cents * direction
    if (!Number.isSafeInteger(total)) throw new Error("Settlement balance exceeds safe integer cents")
    totals.set(id, total)
  }
  const allIds = [...new Set(documentIds)].sort()
  for (let start = 0; start < allIds.length; start += 200) {
    const ids = allIds.slice(start, start + 200)
    const [payments, allocations, reversals] = await Promise.all([
      collectBooksRows((from, to) => client.from("payments").select("id,invoice_id,bill_id,amount_cents").eq("org_id", orgId).in(key, ids).in("status", [...POSTED_PAYMENT_STATUSES]).lt("received_at", cutoff).order("id").range(from, to)),
      collectBooksRows((from, to) => client.from("payment_allocations").select("id,payment_id,invoice_id,bill_id,amount_cents,payment:payments!inner(status,received_at)").eq("org_id", orgId).in(key, ids).in("payment.status", [...POSTED_PAYMENT_STATUSES]).lt("payment.received_at", cutoff).order("id").range(from, to)),
      collectBooksRows((from, to) => client.from("payment_reversals").select("id,invoice_id,bill_id,amount_cents").eq("org_id", orgId).in(key, ids).eq("status", "succeeded").lt("occurred_at", cutoff).order("id").range(from, to)),
    ])
    const allocatedPairs = new Set<string>()
    for (const row of allocations) {
      const id = row[key]
      if (!id) continue
      allocatedPairs.add(`${row.payment_id}:${id}`)
      add(id, row.amount_cents)
    }
    for (const row of payments) {
      const id = row[key]
      if (!id || allocatedPairs.has(`${row.id}:${id}`)) continue
      add(id, row.amount_cents)
    }
    for (const row of reversals) {
      const id = row[key]
      if (id) add(id, row.amount_cents, -1)
    }
    if (side === "receivable") {
      const adjustments = await collectBooksRows((from, to) => client.from("receivable_adjustments").select("id,invoice_id,amount_cents,status,voided_at").eq("org_id", orgId).in("invoice_id", ids).lte("effective_date", asOf).order("id").range(from, to))
      for (const row of adjustments) {
        if (row.status === "posted" || (row.voided_at && row.voided_at >= cutoff)) add(row.invoice_id, row.amount_cents)
      }
    }
  }
  return totals
}

/** A later void must not erase a receivable from an earlier accounting date. */
/**
 * Whether an invoice was receivable at a past date. A voided invoice counts
 * until it was removed: the ledger's date for that (`removedOn`, from
 * `loadLedgerRemovalDates`) when it posted to Arc Books, otherwise the recorded
 * void time.
 */
export function isInvoiceReceivableAsOf(row: { id?: unknown; status: string | null; metadata?: unknown }, asOf: string, removedOn?: ReadonlyMap<string, string>) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {}
  if (metadata.invoice_kind === "earnest_deposit") return false
  if ((BILLED_INVOICE_STATUSES as readonly string[]).includes(row.status ?? "")) return true
  if (row.status !== "void") return false
  const ledgerDate = removedOn?.get(String(row.id))
  if (ledgerDate) return ledgerDate > asOf
  return typeof metadata.voided_at === "string" && metadata.voided_at >= accountingCutoff(asOf)
}

/** Bill statuses a payable can be read from at a past date: payable now, or returned to pending or rejected since. */
export const AS_OF_BILL_STATUSES = [...PAYABLE_VENDOR_BILL_STATUSES, "pending", "rejected"] as const

/**
 * Whether a bill was payable at a past date. A bill returned to pending or
 * rejected after it posted counts until the ledger removed it; otherwise its
 * current status decides.
 */
export function isBillPayableAsOf(row: { id?: unknown; status: string | null }, asOf: string, removedOn?: ReadonlyMap<string, string>) {
  if ((PAYABLE_VENDOR_BILL_STATUSES as readonly string[]).includes(row.status ?? "")) return true
  const ledgerDate = removedOn?.get(String(row.id))
  return Boolean(ledgerDate && ledgerDate > asOf)
}

/**
 * When each voided document stopped counting, as the ledger dated it: the
 * reversal of its last journal entry. A void inside an open month reverses on the
 * document's own date (as if never issued); once its month has closed, on the
 * reversal date. So aging and the ledger tie-out read one date. Documents never
 * posted to Arc Books are absent and fall back to their recorded void time.
 */
export async function loadLedgerRemovalDates(orgId: string, sourceIds: string[]) {
  const service = createServiceSupabaseClient()
  const removed = new Map<string, { date: string; at: string }>()
  for (const slice of chunk([...new Set(sourceIds)], 200)) {
    const reversed = await collectBooksRows((from, to) => service.from("journal_entries").select("id, source_id")
      .eq("org_id", orgId).eq("status", "reversed").in("source_id", slice).order("id").range(from, to))
    const sourceOf = new Map(reversed.map((row) => [String(row.id), String(row.source_id)]))
    for (const entries of chunk([...sourceOf.keys()], 200)) {
      const reversals = await collectBooksRows((from, to) => service.from("journal_entries").select("id, entry_date, created_at, reversal_of_entry_id")
        .eq("org_id", orgId).in("reversal_of_entry_id", entries).in("status", ["posted", "reversed"]).order("id").range(from, to))
      for (const row of reversals) {
        const source = sourceOf.get(String(row.reversal_of_entry_id))
        if (!source) continue
        const current = removed.get(source)
        if (!current || String(row.created_at) > current.at) removed.set(source, { date: String(row.entry_date), at: String(row.created_at) })
      }
    }
  }
  return new Map([...removed].map(([source, value]) => [source, value.date]))
}
