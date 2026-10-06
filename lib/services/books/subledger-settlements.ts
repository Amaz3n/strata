import { BILLED_INVOICE_STATUSES, POSTED_PAYMENT_STATUSES } from "@/lib/financials/ledger-status"
import type { createServiceSupabaseClient } from "@/lib/supabase/server"
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
export function isInvoiceReceivableAsOf(row: { status: string | null; metadata?: unknown }, asOf: string) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {}
  if (metadata.invoice_kind === "earnest_deposit") return false
  if ((BILLED_INVOICE_STATUSES as readonly string[]).includes(row.status ?? "")) return true
  return row.status === "void" && typeof metadata.voided_at === "string" && metadata.voided_at >= accountingCutoff(asOf)
}
