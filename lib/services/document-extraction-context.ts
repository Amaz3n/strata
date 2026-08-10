import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * What Arc already knows about a document before a model looks at it.
 *
 * This is the difference between extraction and reconciliation. A generic
 * document-AI vendor sees a page and guesses; Arc holds the vendor list, the
 * bills that vendor has already sent, and the commitment the invoice is meant
 * to bill against. Handing that context to the model turns two open questions
 * into closed ones:
 *
 *   "who is this from?"  -> pick an id from this list, or null
 *   "have we seen it?"   -> compare against numbers we already hold
 *
 * Everything here is a closed set, and every id the model returns is re-checked
 * against that set before it reaches the caller. The model can narrow a choice;
 * it can never invent one.
 */

/** Bound the candidate lists so a 5,000-vendor org still gets a usable prompt. */
const MAX_VENDOR_CANDIDATES = 400
const MAX_RECENT_BILLS = 60
/** How far back "have we seen this bill number" looks. */
const RECENT_BILL_WINDOW_DAYS = 400

export interface VendorCandidate {
  id: string
  name: string
}

export interface RecentBill {
  billNumber: string
  companyId: string | null
  totalCents: number | null
  billDate: string | null
}

export interface ExtractionExpectations {
  vendors: VendorCandidate[]
  recentBills: RecentBill[]
  /** True when the vendor list was capped, so callers can say so honestly. */
  vendorsTruncated: boolean
}

export const EMPTY_EXPECTATIONS: ExtractionExpectations = {
  vendors: [],
  recentBills: [],
  vendorsTruncated: false,
}

/**
 * Load the candidate sets for one extraction. Best-effort by design: a failure
 * here degrades the scan to unaided reading rather than failing it.
 */
export async function loadExtractionExpectations({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
}): Promise<ExtractionExpectations> {
  const since = new Date(Date.now() - RECENT_BILL_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const [vendorResult, billResult] = await Promise.all([
    supabase
      .from("companies")
      .select("id,name")
      .eq("org_id", orgId)
      .order("name", { ascending: true })
      .limit(MAX_VENDOR_CANDIDATES + 1),
    supabase
      .from("vendor_bills")
      .select("bill_number,company_id,total_cents,bill_date")
      .eq("org_id", orgId)
      .not("bill_number", "is", null)
      .gte("bill_date", since)
      .order("bill_date", { ascending: false })
      .limit(MAX_RECENT_BILLS),
  ])

  if (vendorResult.error) {
    console.warn("[document-extraction] Could not load vendor candidates", vendorResult.error.message)
  }
  if (billResult.error) {
    console.warn("[document-extraction] Could not load recent bills", billResult.error.message)
  }

  const vendorRows = vendorResult.data ?? []
  const vendorsTruncated = vendorRows.length > MAX_VENDOR_CANDIDATES

  return {
    vendors: vendorRows.slice(0, MAX_VENDOR_CANDIDATES).map((row) => ({
      id: row.id as string,
      name: (row.name as string) ?? "",
    })),
    recentBills: (billResult.data ?? []).map((row) => ({
      billNumber: (row.bill_number as string) ?? "",
      companyId: (row.company_id as string | null) ?? null,
      totalCents: row.total_cents === null ? null : Number(row.total_cents),
      billDate: (row.bill_date as string | null) ?? null,
    })),
    vendorsTruncated,
  }
}

/** Compact prompt block. Omitted entirely when there is nothing useful to say. */
export function formatExpectationsForPrompt(expectations: ExtractionExpectations): string {
  if (expectations.vendors.length === 0) return ""

  const lines = [
    "Known vendors in this organization. If the document's vendor is one of these,",
    "return its id verbatim as vendor_id. If it is not in the list, return null for",
    "vendor_id and put the printed name in vendor_name.",
    ...expectations.vendors.map((vendor) => `${vendor.id} | ${vendor.name}`),
  ]

  if (expectations.vendorsTruncated) {
    lines.push("(Vendor list truncated; a missing vendor does not mean the vendor is new.)")
  }

  return lines.join("\n")
}

export {
  detectDuplicateSuspicion,
  normalizeBillNumber,
  type DuplicateSuspicion,
} from "@/lib/financials/payable-duplicates"
