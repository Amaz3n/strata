import { connection } from "next/server"
import { unstable_rethrow } from "next/navigation"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { BillingBook } from "@/components/invoices/billing-book"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { resolveBillingProfile, resolveOrgBillingProfile } from "@/lib/financials/billing-profile"
import { getProjectPosture } from "@/lib/product-tier"
import { getOrgReceivablesPolicy, getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import {
  getOrgBillingSummary,
  getReceivablesAccountingMode,
  type ProjectBillingSummary,
  type ProjectBillingUpNext,
} from "@/lib/services/billing-book"
import { requireOrgContext } from "@/lib/services/context"
import { getFinancialAccountingModesForProjects } from "@/lib/services/financial-accounting"
import { listInvoicePage } from "@/lib/services/invoices"
import { loadOrgBillingDeskData } from "@/lib/services/org-billing-desk"
import { listOrgOwnerBillingPackageSummaries } from "@/lib/services/owner-billing-packages"
import { listBillingDeskProjects } from "@/lib/services/projects"

function messageForError(error: unknown) {
  unstable_rethrow(error)
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

const EMPTY_SUMMARY: ProjectBillingSummary = {
  outstandingCents: 0,
  overdueCents: 0,
  buckets: [0, 0, 0, 0],
  bands: { drafts: 0, awaitingApproval: 0, readyToIssue: 0, open: 0, overdue: 0, exceptions: 0, paid: 0, void: 0 },
  billedCents: 0,
  collectedCents: 0,
  creditedCents: 0,
  retainageHeldCents: 0,
}

/** The one org-wide receivables experience used by current and legacy URLs. */
export async function OrgBillingWorkspace() {
  await connection()
  const context = await requireOrgContext()
  const projectsPromise = listBillingDeskProjects(context.orgId, context)
  const opportunitiesPromise = projectsPromise.then((projects) =>
    loadOrgBillingDeskData(projects.map((project) => project.id)).then(
      (desk) => ({ desk, error: null as string | null }),
      (error: unknown) => ({ desk: null, error: messageForError(error) }),
    ),
  )
  const projectAccountingPromise = projectsPromise.then((projects) =>
    getFinancialAccountingModesForProjects(context.orgId, projects.map((project) => project.id)).catch((error: unknown) => {
      unstable_rethrow(error)
      return {}
    }),
  )
  const [projects, pageResult, summaryResult, opportunitiesResult, packagesResult, orgResult, accounting, booksAccess, accountingByProject] = await Promise.all([
    projectsPromise,
    listInvoicePage({ orgId: context.orgId, queue: "active", limit: 300, sort: "activity", sortDirection: "desc" }).then(
      (page) => ({ page, error: null as string | null }),
      (error: unknown) => ({ page: null, error: messageForError(error) }),
    ),
    getOrgBillingSummary(context.orgId).then(
      (summary) => ({ summary, error: null as string | null }),
      (error: unknown) => ({ summary: EMPTY_SUMMARY, error: messageForError(error) }),
    ),
    opportunitiesPromise,
    listOrgOwnerBillingPackageSummaries(context.orgId).then(
      (packages) => ({ packages, error: null as string | null }),
      (error: unknown) => ({ packages: [], error: messageForError(error) }),
    ),
    context.supabase.from("orgs").select("name,email,address").eq("id", context.orgId).maybeSingle(),
    getReceivablesAccountingMode().catch((error: unknown) => {
      unstable_rethrow(error)
      return { ledger: "unavailable" as const, external: null }
    }),
    getBooksUiAccess(),
    projectAccountingPromise,
  ])
  const policy = getOrgReceivablesPolicy(context.productTier)
  const profile = resolveOrgBillingProfile(policy)


  const projectProfiles = Object.fromEntries(projects.map((project) => {
    const projectPolicy = getReceivablesPosturePolicy(getProjectPosture(project.property_type, context.productTier))
    return [project.id, resolveBillingProfile({ featureConfig: getProjectFinancialFeatureConfig(project, project.billing_contract), policy: projectPolicy })]
  }))
  const upNext: ProjectBillingUpNext = {
    rows: (opportunitiesResult.desk?.readyToBill ?? []).map((entry) => ({
      key: `portfolio:${entry.projectId}`,
      kind: "period_bill",
      title: entry.count === 1 ? "1 billing item ready" : `${entry.count} billing items ready`,
      detail: entry.oldestAgeDays > 0 ? `Oldest unbilled item is ${entry.oldestAgeDays} days old` : "Ready for review",
      amountCents: entry.totalCents,
      state: entry.oldestAgeDays > 60 ? "blocked" : "due",
      actionLabel: "Open project",
      href: entry.href,
      projectName: entry.projectName,
    })),
    periods: [],
    selectedPeriod: null,
    errors: [],
  }
  const loadErrors = [
    pageResult.error ? `Invoices: ${pageResult.error}` : null,
    summaryResult.error ? `Receivables totals: ${summaryResult.error}` : null,
    opportunitiesResult.error ? `Ready to bill: ${opportunitiesResult.error}` : null,
    packagesResult.error ? `Backup packages: ${packagesResult.error}` : null,
    opportunitiesResult.desk?.readyToBillTruncated ? "Ready to bill shows only the oldest unbilled items" : null,
  ].filter((entry): entry is string => Boolean(entry))

  return (
    <PageLayout title={policy.workspaceLabel} fullBleed>
      <BillingBook
        scope={{ kind: "org" }}
        projects={projects}
        profile={profile}
        accounting={accounting}
        canManageDeposits={booksAccess.adjust}
        projectProfiles={projectProfiles}
        accountingByProject={accountingByProject}
        initialRows={pageResult.page?.invoices ?? []}
        initialTotalCount={pageResult.page?.totalCount ?? 0}
        initialSummary={summaryResult.summary}
        initialUpNext={upNext}
        ownerBillingPackages={packagesResult.packages}
        builderInfo={{
          name: orgResult.data?.name ?? null,
          email: orgResult.data?.email ?? null,
          address: typeof orgResult.data?.address === "string" ? orgResult.data.address : null,
        }}
        loadErrors={loadErrors}
      />
    </PageLayout>
  )
}
