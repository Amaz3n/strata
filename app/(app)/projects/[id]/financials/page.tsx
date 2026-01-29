import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import {
  getProjectAction,
  getProjectStatsAction,
  getProjectScheduleAction,
  getProjectContractAction,
  listProjectDrawsAction,
  listProjectRetainageAction,
  getProjectApprovedChangeOrderTotalAction,
} from "../actions"
import { FinancialsTabs } from "@/components/financials/financials-tabs"
import { getOrgBilling } from "@/lib/services/orgs"
import type { Address } from "@/lib/types"

export const dynamic = "force-dynamic"

interface ProjectFinancialsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string }>
}

export default async function ProjectFinancialsPage({ params, searchParams }: ProjectFinancialsPageProps) {
  const { id } = await params
  const { tab } = (await searchParams) ?? {}

  const [
    project,
    stats,
    scheduleItems,
    contract,
    draws,
    retainage,
    approvedChangeOrdersTotalCents,
    orgBilling,
  ] = await Promise.all([
    getProjectAction(id),
    getProjectStatsAction(id),
    getProjectScheduleAction(id),
    getProjectContractAction(id),
    listProjectDrawsAction(id),
    listProjectRetainageAction(id),
    getProjectApprovedChangeOrderTotalAction(id),
    getOrgBilling().catch(() => null),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Financials"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Financials" },
      ]}
    >
      <div className="space-y-6">
        <FinancialsTabs
          projectId={project.id}
          project={project}
          initialTab={tab}
          contract={contract}
          budgetSummary={stats.budgetSummary}
          approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
          scheduleItems={scheduleItems}
          draws={draws}
          retainage={retainage}
          builderInfo={{
            name: orgBilling?.org?.name,
            email: orgBilling?.org?.billing_email,
            address: formatAddress(orgBilling?.org?.address as Address | undefined),
          }}
        />
      </div>
    </PageLayout>
  )
}

function formatAddress(address?: Address) {
  if (!address) return undefined
  const parts = [
    address.formatted,
    [address.street1, address.street2].filter(Boolean).join(" "),
    [address.city, address.state].filter(Boolean).join(", "),
    address.postal_code,
    address.country,
  ]
    .map((part) => part?.trim())
    .filter((part) => !!part && part.length > 0)

  return parts.join("\n")
}
