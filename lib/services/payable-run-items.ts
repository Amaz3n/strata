import type { SupabaseClient } from "@supabase/supabase-js"

import { ACTIVE_PAYABLE_RUN_ITEM_STATUSES } from "@/lib/financials/payables-queues"

export interface ActivePayableRunItem {
  id: string
  bill_id: string | null
  run_id: string | null
  status: string
  disbursement_status: string | null
}

const PAGE_SIZE = 1_000
const SAFETY_LIMIT = 25_000

/**
 * Active run membership is a money-safety boundary: silently truncating it can
 * offer an already-claimed bill for a second payment. Page until exhausted and
 * fail closed if an organization ever exceeds the explicit safety ceiling.
 */
export async function listActivePayableRunItems(
  supabase: SupabaseClient,
  orgId: string,
  options: { billIds?: string[] } = {},
): Promise<ActivePayableRunItem[]> {
  if (options.billIds && options.billIds.length === 0) return []
  const rows: Array<Omit<ActivePayableRunItem, "disbursement_status">> = []

  for (let from = 0; from < SAFETY_LIMIT; from += PAGE_SIZE) {
    let query = supabase
      .from("payment_run_items")
      .select("id,bill_id,run_id,status")
      .eq("org_id", orgId)
      .in("status", [...ACTIVE_PAYABLE_RUN_ITEM_STATUSES])
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (options.billIds) query = query.in("bill_id", options.billIds)
    const { data, error } = await query
    if (error) throw new Error(`Unable to load active payable runs: ${error.message}`)
    const page = (data ?? []) as Array<Omit<ActivePayableRunItem, "disbursement_status">>
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    if (from + PAGE_SIZE >= SAFETY_LIMIT) {
      throw new Error("Active payable runs exceed the safe list limit; payment selection is disabled until the queue is reduced.")
    }
  }
  const statusByItemId = new Map<string, string>()
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map((row) => row.id)
    const { data, error } = await supabase.from("disbursements").select("run_item_id,status,created_at")
      .eq("org_id", orgId).in("run_item_id", ids).order("created_at", { ascending: false })
    if (error) throw new Error(`Unable to load payable disbursement stages: ${error.message}`)
    for (const row of data ?? []) if (!statusByItemId.has(row.run_item_id)) statusByItemId.set(row.run_item_id, row.status)
  }
  return rows.map((row) => ({ ...row, disbursement_status: statusByItemId.get(row.id) ?? null }))
}
