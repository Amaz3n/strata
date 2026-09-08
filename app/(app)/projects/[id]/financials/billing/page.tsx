import { notFound } from "next/navigation"
import { Suspense } from "react"

import { getProjectAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { BillingBook } from "@/components/invoices/billing-book"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { resolveBillingProfile } from "@/lib/financials/billing-profile"
import { getProjectPosture } from "@/lib/product-tier"
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import { getProjectBillingFacts, getProjectBillingSummary, getProjectBillingUpNext, getReceivablesAccountingMode } from "@/lib/services/billing-book"
import { requireOrgContext } from "@/lib/services/context"
import { listInvoicePage } from "@/lib/services/invoices"
import { getOrgBilling } from "@/lib/services/orgs"
import { listProjectOwnerBillingPackageSummaries } from "@/lib/services/owner-billing-packages"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import type { Address } from "@/lib/types"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ period?: string }>
}

export default async function ProjectBillingPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { period } = (await searchParams) ?? {}

  return (
    <Suspense fallback={<BillingSkeleton />}>
      <BillingData id={id} periodId={period ?? null} />
    </Suspense>
  )
}

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

/**
 * Two phases, each fully parallel. The first is what the profile needs; the
 * second is what the profile decides. Nothing here loads a tab the person is
 * not looking at, because there are no tabs.
 */
async function BillingData({ id, periodId }: { id: string; periodId: string | null }) {
  // Cookies first: everything below is dated ("overdue" is a function of today),
  // and the prerender has to know it is dynamic before anyone asks for the time.
  const context = await requireOrgContext()
  const [project, contract, setupStatus, facts, rowsResult, accountingResult, orgBillingResult] = await Promise.all([
    getProjectAction(id),
    getProjectContractAction(id),
    getProjectFinancialSetupStatusForProject(id),
    getProjectBillingFacts(id).catch(() => ({ hasSov: false, hasPayApplications: false })),
    listInvoicePage({ projectId: id, queue: "active", limit: 300, sort: "activity", sortDirection: "desc" }).then(
      (page) => ({ page, error: null as string | null }),
      (error: unknown) => ({ page: null, error: messageForError(error) }),
    ),
    getReceivablesAccountingMode(context.orgId, id).catch(() => ({ ledger: "unavailable" as const, external: null })),
    getOrgBilling().catch(() => null),
  ])
  if (!project) notFound()

  const featureConfig = getProjectFinancialFeatureConfig(project, contract)
  const policy = getReceivablesPosturePolicy(getProjectPosture(project.property_type, context.productTier))
  const profile = resolveBillingProfile({ featureConfig, policy, facts })

  const [summaryResult, upNextResult, packagesResult] = await Promise.allSettled([
    getProjectBillingSummary(id, { includeSovRetainage: profile.progressBilling }),
    getProjectBillingUpNext(id, profile, { selectedPeriodId: periodId, contractTotalCents: contract?.total_cents ?? 0 }),
    profile.costDriven ? listProjectOwnerBillingPackageSummaries(id) : Promise.resolve([]),
  ])

  const loadErrors = [
    rowsResult.error ? `Invoices: ${rowsResult.error}` : null,
    summaryResult.status === "rejected" ? `Receivables totals: ${messageForError(summaryResult.reason)}` : null,
    upNextResult.status === "rejected" ? `Up next: ${messageForError(upNextResult.reason)}` : null,
    packagesResult.status === "rejected" ? `Backup packages: ${messageForError(packagesResult.reason)}` : null,
  ].filter((entry): entry is string => Boolean(entry))

  const summary =
    summaryResult.status === "fulfilled"
      ? summaryResult.value
      : {
          outstandingCents: 0,
          overdueCents: 0,
          buckets: [0, 0, 0, 0] as [number, number, number, number],
          bands: { drafts: 0, awaitingApproval: 0, readyToIssue: 0, open: 0, overdue: 0, exceptions: 0, paid: 0, void: 0 },
          billedCents: 0,
          collectedCents: 0,
          creditedCents: 0,
          retainageHeldCents: 0,
        }
  const upNext = upNextResult.status === "fulfilled" ? upNextResult.value : null

  return (
    <PageLayout
      title="Billing"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Billing" },
      ]}
      fullBleed
    >
      <FinancialSetupStatusBanner setup={setupStatus} />
      <BillingBook
        scope={{ kind: "project", projectId: project.id }}
        projects={[{ ...project, billing_contract: contract }]}
        profile={profile}
        accounting={accountingResult}
        contract={contract}
        initialRows={rowsResult.page?.invoices ?? []}
        initialTotalCount={rowsResult.page?.totalCount ?? 0}
        initialSummary={summary}
        initialUpNext={upNext}
        selectedPeriodId={upNext?.selectedPeriod?.id ?? periodId}
        costCodesEnabled={setupStatus.costCodesEnabled}
        ownerBillingPackages={packagesResult.status === "fulfilled" ? packagesResult.value : []}
        builderInfo={{
          name: orgBillingResult?.org?.name,
          email: orgBillingResult?.org?.billing_email,
          address: formatAddress(orgBillingResult?.org?.address as Address | undefined),
        }}
        loadErrors={loadErrors}
      />
    </PageLayout>
  )
}

function formatAddress(address?: Address) {
  if (!address) return undefined
  const structured = [
    [address.street1, address.street2].filter(Boolean).join(" ").trim(),
    [address.city, address.state, address.postal_code].filter(Boolean).join(" ").trim(),
    (address.country ?? "").trim(),
  ].filter(Boolean)
  if (structured.length > 0) return structured.join("\n")
  return address.formatted?.trim() || undefined
}

function BillingSkeleton() {
  return (
    <PageLayout title="Billing" breadcrumbs={[{ label: "Project" }, { label: "Billing" }]} fullBleed>
      <div className="w-full">
        <div className="flex min-h-14 items-center justify-between gap-4 border-b px-4 sm:px-6 lg:px-8">
          <Skeleton className="h-5 w-64" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
        <div className="divide-y">
          <Skeleton className="h-8 w-full rounded-none opacity-60" />
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={`up-${index}`} className="flex items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
          <Skeleton className="h-8 w-full rounded-none opacity-60" />
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={`open-${index}`} className="flex items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  )
}
