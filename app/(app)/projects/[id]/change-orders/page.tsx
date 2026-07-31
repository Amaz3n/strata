import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listChangeOrdersAction } from "@/app/(app)/change-orders/actions"
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"
import { Skeleton } from "@/components/ui/skeleton"
import { getOrgBilling } from "@/lib/services/orgs"
import { requireOrgContext } from "@/lib/services/context"
import { getOrgCostCodesEnabled, resolveCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"
import { listProjectBudgetLines } from "@/lib/services/budgets"
import { listCostCodes } from "@/lib/services/cost-codes"
import type { Address } from "@/lib/types"

import { unwrapAction } from "@/lib/action-result"
import { listChangeEvents } from "@/lib/services/change-events"
import { ChangeEventsClient } from "@/components/change-orders/change-events-client"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface ProjectChangeOrdersPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ new?: string; title?: string; description?: string }>
}

export default async function ProjectChangeOrdersPage({
  params,
  searchParams,
}: ProjectChangeOrdersPageProps) {
  const { id } = await params
  const query = await searchParams
  // `?new=1&description=…` — a takeoff quantity moved after a revision and the
  // estimator chose to draft a CO. The composer opens prefilled; nothing is
  // created until they submit.
  const initialDraft =
    query.new === "1"
      ? { title: query.title ?? null, notes: query.description ?? null }
      : null

  return (
    <>
      <PageLayout title="Change Orders" breadcrumbs={[
        { label: "Project" },
        { label: "Change Orders" },
      ]} />
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <ProjectChangeOrdersData id={id} initialDraft={initialDraft} />
      </Suspense>
    </>
  )
}

async function ProjectChangeOrdersData({
  id,
  initialDraft,
}: {
  id: string
  initialDraft: { title: string | null; notes: string | null } | null
}) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const { supabase, orgId } = await requireOrgContext()
  const costCodesEnabled = resolveCostCodesEnabled(
    project.financial_settings?.cost_codes_enabled,
    await getOrgCostCodesEnabled(supabase, orgId),
  )
  const [changeOrders, changeEvents, orgBilling, costCodes, budgetLines] = await Promise.all([
    listChangeOrdersAction(id),
    listChangeEvents(id).catch(() => []),
    getOrgBilling().catch(() => null),
    costCodesEnabled ? listCostCodes().catch(() => []) : Promise.resolve([]),
    costCodesEnabled ? Promise.resolve([]) : listProjectBudgetLines(id).catch(() => []),
  ])

  return (
    <Tabs defaultValue="events" className="space-y-4">
      <TabsList><TabsTrigger value="events">Change events</TabsTrigger><TabsTrigger value="orders">Change orders</TabsTrigger></TabsList>
      <TabsContent value="events"><ChangeEventsClient projectId={id} initialEvents={changeEvents} /></TabsContent>
      <TabsContent value="orders"><ChangeOrdersClient
        changeOrders={changeOrders}
        projects={[project]}
        costCodes={costCodes}
        budgetLines={budgetLines}
        costCodesEnabled={costCodesEnabled}
        hideProjectFilter
        initialDraft={initialDraft}
        builderInfo={{
          name: orgBilling?.org?.name,
          email: orgBilling?.org?.billing_email,
          address: formatAddress(orgBilling?.org?.address as Address | undefined),
        }}
      /></TabsContent>
    </Tabs>
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
