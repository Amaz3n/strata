import "server-only"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { loadProjectRevenueBases } from "@/lib/services/books/revenue-basis"
import { accountingCutoff, isInvoiceReceivableAsOf } from "@/lib/services/books/subledger-settlements"

/** Project lifecycle status cannot erase a job from an earlier accounting period. */
export async function loadPocProjectsForPeriod(orgId: string, periodEnd: string) {
  accountingCutoff(periodEnd)
  const service = createServiceSupabaseClient()
  const [bases, costs, invoices, recognized] = await Promise.all([
    loadProjectRevenueBases(orgId, periodEnd),
    collectBooksRows((from, to) => service.from("job_cost_entries").select("id,project_id")
      .eq("org_id", orgId).eq("status", "posted").lte("incurred_on", periodEnd).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("invoices").select("id,project_id,status,metadata")
      .eq("org_id", orgId).lte("issue_date", periodEnd).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("journal_entries").select("id,source_id")
      .eq("org_id", orgId).eq("source_type", "revenue_recognition")
      .in("status", ["posted", "reversed"]).lte("entry_date", periodEnd).order("id").range(from, to)),
  ])
  const ids = new Set([
    ...costs.map(row => row.project_id),
    ...invoices.filter(row => isInvoiceReceivableAsOf(row, periodEnd)).map(row => row.project_id),
    ...recognized.map(row => row.source_id),
  ].filter((id): id is string => typeof id === "string"))
  return bases.filter(project => project.basis === "percentage_of_completion" && ids.has(project.projectId))
}
