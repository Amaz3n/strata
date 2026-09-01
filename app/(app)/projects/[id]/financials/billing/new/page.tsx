import { notFound } from "next/navigation"
import { Suspense } from "react"

import { InvoiceComposer, type BillingSourceOption } from "@/components/invoices/invoice-composer"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectFinancialFeatureConfig, isCostDrivenBillingModel } from "@/lib/financials/billing-model"
import { projectBillingHref } from "@/lib/financials/invoice-destinations"
import { getProjectPosture } from "@/lib/product-tier"
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import { requireOrgContext } from "@/lib/services/context"
import { listBillableContacts } from "@/lib/services/contacts"
import { listCostCodes } from "@/lib/services/cost-codes"
import { getInvoiceWithLines } from "@/lib/services/invoices"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { getOrgBilling } from "@/lib/services/orgs"
import { getProjectIdentity } from "@/lib/services/projects"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ draft?: string; duplicate?: string; source?: string; customer?: string }>
}

/**
 * The invoice composer's own route.
 *
 * `?draft=` resumes an autosaved draft, `?duplicate=` seeds from an existing
 * invoice, `?source=change_order:<id>` starts from a change order. All three are
 * the same task, so they are the same route rather than three different overlays
 * over the list.
 */
export default async function NewInvoicePage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = (await searchParams) ?? {}

  return (
    <Suspense fallback={<ComposerSkeleton />}>
      <ComposerData projectId={id} query={query} />
    </Suspense>
  )
}

async function ComposerData({
  projectId,
  query,
}: {
  projectId: string
  query: { draft?: string; duplicate?: string; source?: string; customer?: string }
}) {
  const context = await requireOrgContext()
  const project = await getProjectIdentity(projectId)
  if (!project) notFound()

  const posture = getProjectPosture(project.property_type, context.productTier)
  const policy = getReceivablesPosturePolicy(posture)

  const [contacts, costCodes, orgBilling, draft, duplicate, financialSettings, activeContract] = await Promise.all([
    listBillableContacts(context.orgId).catch(() => []),
    listCostCodes(context.orgId).catch(() => []),
    getOrgBilling().catch(() => null),
    query.draft ? getInvoiceWithLines(query.draft, context.orgId).catch(() => null) : Promise.resolve(null),
    query.duplicate ? getInvoiceWithLines(query.duplicate, context.orgId).catch(() => null) : Promise.resolve(null),
    context.supabase
      .from("project_financial_settings")
      .select("billing_model, fixed_price_billing_basis")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .maybeSingle(),
    context.supabase
      .from("contracts")
      .select("contract_type, fixed_fee_cents, gmp_cents, snapshot, open_book, requires_client_cost_approval, retainage_percent")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const featureConfig = getProjectFinancialFeatureConfig({
    status: project.status ?? undefined,
    property_type: project.property_type ?? undefined,
    billing_contract: activeContract.data ?? null,
    financial_settings: financialSettings.data ?? null,
  })
  const costDriven = isCostDrivenBillingModel(featureConfig.billingModel)

  // A brand-new invoice reserves its number up front so two people composing at
  // once never collide. Resuming a draft already owns one.
  const reservation = draft ? null : await getNextInvoiceNumber(context.orgId).catch(() => null)

  const billingHref = projectBillingHref(projectId)
  const sources: BillingSourceOption[] = []
  if (featureConfig.showDraws) {
    sources.push({
      key: "draw",
      label: "A draw",
      description: "Bill a scheduled draw. The draw schedule builds the invoice and keeps the two in step.",
      href: `${billingHref}?tab=draws`,
    })
  }
  if (policy.supportsProgressApplications) {
    sources.push({
      key: "pay_application",
      label: "A pay application",
      description: "Progress billing against the schedule of values, with retainage and continuation sheet.",
      href: `${billingHref}?tab=payapps`,
    })
  }
  if (costDriven) {
    sources.push({
      key: "from_costs",
      label: "Approved costs",
      description: "Close the period and bill the costs that cleared review, with their backup attached.",
      href: `${billingHref}?tab=close`,
    })
  }
  if (featureConfig.billingModel === "cost_plus_fixed_fee") {
    sources.push({
      key: "fee",
      label: "The management fee",
      description: "Bill earned fee from the fee schedule.",
      href: `${billingHref}?tab=fee`,
    })
  }
  if (policy.supportsClosingInvoices) {
    sources.push({
      key: "closing",
      label: "A closing statement",
      description: "Settle deposits, options and incentives at closing.",
      href: `/projects/${projectId}/closeout`,
    })
  }
  sources.push({
    key: "manual",
    label: "Something else",
    description: `A one-off invoice you write yourself — a change order, a deposit, or a ${policy.customerLabel.toLowerCase()} reimbursement.`,
    start: true,
  })

  const sourceParam = query.source
  const initialSourceChangeOrderId = sourceParam?.startsWith("change_order:")
    ? sourceParam.slice("change_order:".length)
    : undefined

  return (
    <PageLayout
      title={draft ? `Invoice ${draft.invoice_number}` : "New invoice"}
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials", href: `/projects/${project.id}/financials` },
        { label: "Billing", href: billingHref },
        { label: draft ? "Edit" : "New" },
      ]}
      fullBleed
    >
      <div className="h-[calc(100vh-3.5rem)]">
        <InvoiceComposer
          project={project}
          projects={[project]}
          posture={posture}
          policy={policy}
          sources={sources}
          contacts={contacts}
          costCodes={costCodes}
          enableApprovedCostsSource={costDriven}
          initialInvoice={draft}
          duplicateFrom={duplicate}
          initialSourceChangeOrderId={initialSourceChangeOrderId}
          initialCustomerId={query.customer}
          reservation={
            reservation ? { number: String(reservation.number ?? ""), reservationId: reservation.reservation_id ?? null } : null
          }
          builderInfo={{
            name: orgBilling?.org?.name ?? null,
            email: orgBilling?.org?.billing_email ?? null,
            address: formatOrgAddress(orgBilling?.org?.address),
          }}
        />
      </div>
    </PageLayout>
  )
}

/** The org's address is stored as a JSON block; the document wants lines of text. */
function formatOrgAddress(address: unknown): string | null {
  if (typeof address === "string") return address.trim() || null
  if (!address || typeof address !== "object") return null
  const parts = ["line1", "line2", "city", "state", "postal_code"]
    .map((key) => (address as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  return parts.length > 0 ? parts.join(", ") : null
}

function ComposerSkeleton() {
  return (
    <PageLayout title="New invoice" breadcrumbs={[{ label: "Project" }, { label: "Financials" }, { label: "Billing" }]} fullBleed>
      <div className="flex h-[calc(100vh-3.5rem)] flex-col">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="ml-auto h-8 w-48" />
        </div>
        <div className="flex-1 space-y-6 px-8 py-8">
          <div className="flex items-start justify-between gap-8">
            <div className="space-y-2">
              <Skeleton className="h-7 w-44" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-24 w-56" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </PageLayout>
  )
}
