import { BillingQueue } from "@/components/invoices/billing-queue"
import { PageLayout } from "@/components/layout/page-layout"
import { NoProjectSelected } from "@/components/projects/no-project-selected"
import { emptyArAgingTotals } from "@/lib/financials/invoice-lifecycle"
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { getOrgReceivablesPolicy } from "@/lib/receivables/policy"
import { requireOrgContext } from "@/lib/services/context"
import { getInvoiceQueueCounts, listInvoicePage, type InvoiceArSummary } from "@/lib/services/invoices"
import { listProjects } from "@/lib/services/projects"
import { getArAgingReport } from "@/lib/services/reports/ar-aging"

/**
 * The org-wide AR desk: the same queue as a project's billing workbench, read
 * across every job. Deliberately the same component — a receivable does not
 * change shape depending on which page you are standing on, and running two
 * implementations is how the project list and this one came to disagree about
 * what "overdue" meant.
 */
export default async function InvoicesPage() {
  const context = await requireOrgContext()
  const [projects, page, counts, arReport, orgResult, billedResult] = await Promise.all([
    listProjects(context.orgId, context),
    listInvoicePage({ orgId: context.orgId, limit: 100, sort: "activity", sortDirection: "desc" }),
    getInvoiceQueueCounts({ orgId: context.orgId }),
    getArAgingReport({ orgId: context.orgId }),
    context.supabase.from("orgs").select("name,email,address").eq("id", context.orgId).maybeSingle(),
    context.supabase
      .from("invoices")
      .select("total_cents")
      .eq("org_id", context.orgId)
      .in("status", [...BILLED_INVOICE_STATUSES]),
  ])
  const policy = getOrgReceivablesPolicy(context.productTier)

  if (projects.length === 0) {
    return (
      <PageLayout title={policy.workspaceLabel}>
        <NoProjectSelected />
      </PageLayout>
    )
  }

  const buckets: [number, number, number, number] = [
    arReport.totals["1_30"],
    arReport.totals["31_60"],
    arReport.totals["61_90"],
    arReport.totals["90_plus"],
  ]
  const billedCents = (billedResult.data ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
  const outstandingCents = arReport.totals.total_open_cents
  const arSummary: InvoiceArSummary = {
    ...emptyArAgingTotals(),
    outstandingCents,
    overdueCents: buckets.reduce((sum, value) => sum + value, 0),
    buckets,
    billedCents,
    // Credits are attributed per project, not aggregated org-wide here; the
    // difference between billed and outstanding is what has actually come in.
    creditedCents: 0,
    collectedCents: Math.max(0, billedCents - outstandingCents),
  }

  return (
    <PageLayout title={policy.workspaceLabel} fullBleed>
      <BillingQueue
        projects={projects}
        initialInvoices={page.invoices}
        initialTotalCount={page.totalCount}
        initialCounts={counts}
        enableApprovedCostsSource
        arSummary={arSummary}
        builderInfo={{
          name: orgResult.data?.name ?? null,
          email: orgResult.data?.email ?? null,
          address: typeof orgResult.data?.address === "string" ? orgResult.data.address : null,
        }}
      />
    </PageLayout>
  )
}
