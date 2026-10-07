import "server-only"
import { z } from "zod"
import { chunk } from "@/lib/utils"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { loadProjectRevenueBases } from "@/lib/services/books/revenue-basis"
import { accountingCutoff, isInvoiceReceivableAsOf } from "@/lib/services/books/subledger-settlements"

/**
 * Percentage-of-completion projects active by a period end: with posted cost, a
 * receivable invoice, or recognized revenue. Project lifecycle status cannot
 * erase a job from an earlier accounting period. Reads are limited to those
 * projects, and cost only needs to exist, not to be read line by line.
 */
export async function loadPocProjectsForPeriod(orgId: string, periodEnd: string) {
  accountingCutoff(periodEnd)
  const service = createServiceSupabaseClient()
  const poc = (await loadProjectRevenueBases(orgId, periodEnd)).filter(project => project.basis === "percentage_of_completion")
  const pocIds = poc.map(project => project.projectId)
  if (pocIds.length === 0) return []
  const [costed, invoices, recognized] = await Promise.all([
    service.rpc("books_projects_with_posted_cost", { p_org_id: orgId, p_as_of: periodEnd, p_project_ids: pocIds }),
    Promise.all(chunk(pocIds, 200).map(slice => collectBooksRows((from, to) => service.from("invoices").select("id,project_id,status,metadata")
      .eq("org_id", orgId).lte("issue_date", periodEnd).in("project_id", slice).order("id").range(from, to)))).then(pages => pages.flat()),
    Promise.all(chunk(pocIds, 200).map(slice => collectBooksRows((from, to) => service.from("journal_entries").select("id,source_id")
      .eq("org_id", orgId).eq("source_type", "revenue_recognition").in("source_id", slice)
      .in("status", ["posted", "reversed"]).lte("entry_date", periodEnd).order("id").range(from, to)))).then(pages => pages.flat()),
  ])
  if (costed.error) throw new Error(`Failed to load projects with job cost: ${costed.error.message}`)
  const ids = new Set([
    ...z.array(z.string()).parse(costed.data ?? []),
    ...invoices.filter(row => isInvoiceReceivableAsOf(row, periodEnd)).map(row => row.project_id),
    ...recognized.map(row => row.source_id),
  ].filter((id): id is string => typeof id === "string"))
  return poc.filter(project => ids.has(project.projectId))
}
