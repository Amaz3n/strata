import { accountingReference } from "@/lib/services/accounting-coding"
import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  detectDuplicateSuspicion,
  normalizeBillNumber,
  type RecentBillForDuplicateCheck,
} from "@/lib/financials/payable-duplicates"

/**
 * One way to ask "have we already got this bill?".
 *
 * There were four, and they disagreed in ways that showed up as real defects:
 * the interactive create path matched bill numbers case-insensitively while
 * email ingest used a case-sensitive `eq`, so `INV-1024` and `inv-1024` were the
 * same payable on one path and two payables on the other. None of them handled
 * separator drift (`INV-1024` vs `INV 1024`), and none had an answer when the
 * vendor printed no number at all.
 *
 * Matching lives here; the REACTION stays with the caller, because it genuinely
 * differs — creation blocks, auto-approval declines to fire, ingest reports.
 */

/** Candidate window. Wide enough to catch separator drift, bounded for cost. */
const CANDIDATE_LIMIT = 200
const RECENT_WINDOW_DAYS = 400

export interface DuplicateMatch {
  billId: string
  reason: string
}

/**
 * Look for an existing payable that this one duplicates.
 *
 * Deliberately fetches a candidate set and matches in code rather than pushing
 * the comparison into SQL: normalization has to be identical everywhere, and a
 * shared pure function is the only way to guarantee that.
 */
export async function findDuplicatePayable({
  supabase,
  orgId,
  billNumber,
  companyId,
  totalCents,
  billDate,
  excludeBillId,
  vendorAliases,
}: {
  supabase: SupabaseClient
  orgId: string
  billNumber: string | null
  companyId: string | null
  totalCents?: number | null
  billDate?: string | null
  excludeBillId?: string
  /**
   * Extra ways the same vendor can be recognised when `companyId` is unset —
   * an accounting-system vendor id, or the name printed on the bill. The
   * interactive create path has always matched on these; keeping them here is
   * what lets every caller share one matcher instead of forking again.
   */
  vendorAliases?: { accountingVendorId?: string | null; connectionId?: string | null; vendorName?: string | null }
}): Promise<DuplicateMatch | null> {
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  let query = supabase
    .from("vendor_bills")
    .select("id,bill_number,invoice_number_normalized,company_id,total_cents,bill_date,accounting_coding,vendor_name_normalized,metadata")
    .eq("org_id", orgId)
    .neq("status", "rejected")
    // Ordered, deliberately. An unordered `limit` let Postgres return whichever
    // rows it liked, so on a busy org the candidate window could exclude the
    // very payable being duplicated — a duplicate-payment control that quietly
    // stops working as the org gets bigger is worse than none.
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_LIMIT)

  if (excludeBillId) query = query.neq("id", excludeBillId)

  // With a number, scope by vendor when we know it. Without one, the amount+date
  // fallback needs the vendor, so scope by it regardless.
  if (companyId && !vendorAliases) query = query.eq("company_id", companyId)
  if (billNumber?.trim()) {
    query = query.eq("invoice_number_normalized", normalizeBillNumber(billNumber))
  } else {
    query = query.gte("bill_date", since)
  }

  const { data, error } = await query
  if (error) {
    // Duplicate detection protects the liability itself. Treating an
    // unavailable database check as "no duplicate" lets the same invoice be
    // created and paid twice precisely when the control is unhealthy.
    throw new Error(`Unable to verify whether this payable is a duplicate: ${error.message}`)
  }

  const scopedIds = new Set<string>()
  if (vendorAliases?.accountingVendorId && vendorAliases.connectionId && (data ?? []).length) {
    const { data: mappings, error: mappingError } = await supabase.from("accounting_sync_records")
      .select("entity_id").eq("org_id", orgId).eq("connection_id", vendorAliases.connectionId)
      .eq("entity_type", "bill").in("entity_id", (data ?? []).map((row) => row.id))
    if (mappingError) throw new Error(`Unable to verify payable accounting identity: ${mappingError.message}`)
    for (const mapping of mappings ?? []) scopedIds.add(mapping.entity_id)
  }

  // When aliases are supplied, a candidate counts as the same vendor if any
  // identity lines up; company_id alone would miss QBO-imported bills.
  const sameVendor = (row: Record<string, unknown>) => {
    if (!vendorAliases) return true
    if (companyId && row.company_id === companyId) return true
    if (vendorAliases.accountingVendorId && scopedIds.has(String(row.id)) && accountingReference(row.accounting_coding, "counterparty")?.id === vendorAliases.accountingVendorId) return true
    const alias = vendorAliases.vendorName ? normalizeBillNumber(vendorAliases.vendorName) : ""
    if (!alias) return false
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {}
    const rowName = String(row.vendor_name_normalized ?? normalizeBillNumber(String(metadata.vendor_name ?? accountingReference(row.accounting_coding, "counterparty")?.name ?? "")))
    return Boolean(rowName) && rowName === alias
  }

  const rows = (data ?? []).filter((row) => sameVendor(row))
  const candidates: Array<RecentBillForDuplicateCheck & { id: string }> = rows.map((row) => ({
    id: row.id as string,
    billNumber: (row.bill_number as string | null) ?? "",
    companyId: (row.company_id as string | null) ?? null,
    totalCents: row.total_cents === null ? null : Number(row.total_cents),
    billDate: (row.bill_date as string | null) ?? null,
  }))

  const verdict = detectDuplicateSuspicion({
    billNumber,
    companyId,
    totalCents: totalCents ?? null,
    billDate: billDate ?? null,
    recentBills: candidates,
  })
  if (!verdict.isSuspected) return null

  // Re-run per candidate to identify which one matched.
  const hit = candidates.find(
    (candidate) =>
      detectDuplicateSuspicion({
        billNumber,
        companyId,
        totalCents: totalCents ?? null,
        billDate: billDate ?? null,
        recentBills: [candidate],
      }).isSuspected,
  )

  return hit ? { billId: hit.id, reason: verdict.reason ?? "A similar payable already exists." } : null
}
