import { InvoicesClient } from "@/components/invoices/invoices-client"
import { PageLayout } from "@/components/layout/page-layout"
import { NoProjectSelected } from "@/components/projects/no-project-selected"
import { listContacts } from "@/lib/services/contacts"
import { listCostCodes } from "@/lib/services/cost-codes"
import { requireOrgContext } from "@/lib/services/context"
import { listInvoices } from "@/lib/services/invoices"
import { listProjects } from "@/lib/services/projects"
import { getArAgingReport } from "@/lib/services/reports/ar-aging"
import { getOrgReceivablesPolicy } from "@/lib/receivables/policy"


export default async function InvoicesPage() {
  const context = await requireOrgContext()
  const [projects, invoices, contacts, costCodes, arReport, orgResult] = await Promise.all([
    listProjects(context.orgId, context),
    listInvoices({ orgId: context.orgId, limit: 100 }),
    listContacts(context.orgId),
    listCostCodes(context.orgId),
    getArAgingReport({ orgId: context.orgId }),
    context.supabase
      .from("orgs")
      .select("name,email,address")
      .eq("id", context.orgId)
      .maybeSingle(),
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

  return (
    <PageLayout title={policy.workspaceLabel} fullBleed>
      <InvoicesClient
        invoices={invoices}
        projects={projects}
        contacts={contacts}
        costCodes={costCodes}
        enableApprovedCostsSource
        builderInfo={{
          name: orgResult.data?.name ?? null,
          email: orgResult.data?.email ?? null,
          address: typeof orgResult.data?.address === "string" ? orgResult.data.address : null,
        }}
        arSummary={{
          outstandingCents: arReport.totals.total_open_cents,
          overdueCents: buckets.reduce((sum, value) => sum + value, 0),
          buckets,
        }}
      />
    </PageLayout>
  )
}
