import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Refuses to take a posted document out of a closed month.
 *
 * Returning a bill to pending, or voiding or revising an invoice, removes its
 * journal entry on that entry's own date. When the entry sits in a closed month
 * that removal cannot post, so the document and the ledger would disagree until
 * someone reopened the month, and the closed month's subledger would change under
 * its saved reports. The change is refused with its cure instead.
 */
export async function assertNotPostedInClosedPeriod(input: { orgId: string; sourceId: string; document: "bill" | "invoice"; action: string }) {
  const service = createServiceSupabaseClient()
  const { data: entries, error } = await service.from("journal_entries").select("period_id")
    .eq("org_id", input.orgId).eq("source_id", input.sourceId).eq("status", "posted").not("period_id", "is", null)
  if (error) throw new Error(`Unable to check the ${input.document}'s accounting period: ${error.message}`)
  const periodIds = [...new Set((entries ?? []).map((row) => String(row.period_id)))]
  if (!periodIds.length) return
  const { data: closed, error: periodError } = await service.from("accounting_periods").select("period_start")
    .eq("org_id", input.orgId).eq("status", "closed").in("id", periodIds).order("period_start").limit(1).maybeSingle()
  if (periodError) throw new Error(`Unable to check the ${input.document}'s accounting period: ${periodError.message}`)
  if (!closed) return
  const month = new Date(`${closed.period_start}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  const credit = input.document === "bill" ? "a vendor credit" : "a credit memo"
  throw new Error(`This ${input.document} is posted in ${month}, which is closed. Reopen ${month} to ${input.action}, or record ${credit} in an open month.`)
}
