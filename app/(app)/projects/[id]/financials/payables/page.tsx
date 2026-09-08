import { parsePayablesBookQuery } from "@/lib/financials/payables-book"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { FinancialSetupStatusBanner } from "@/components/financials/financial-setup-status-banner"
import { PayablesDesk } from "@/components/payables/payables-desk"
import { PageLayout } from "@/components/layout/page-layout"
import LoadingPayables from "@/app/(app)/payables/loading"
import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { requireOrgContext } from "@/lib/services/context"

type Query = Record<string, string | undefined> & { tab?: string; queue?: string; due?: string; q?: string; page?: string; pageSize?: string; bill?: string }

export default async function FinancialsPayablesPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<Query>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  return <Suspense fallback={<PageLayout title="Payables" fullBleed><LoadingPayables /></PageLayout>}>
    <ProjectPayablesData id={id} query={query} />
  </Suspense>
}

async function ProjectPayablesData({ id, query }: { id: string; query: Query }) {
  const { orgId, userId } = await requireOrgContext()
  const [project, setup, data, payment] = await Promise.all([
    getProjectAction(id),
    getProjectFinancialSetupStatusForProject(id),
    loadOrgPayablesDesk([id], {
      ...parsePayablesBookQuery(query), search: query.q, billId: query.bill,
      page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 25,
      projectScope: true,
    }),
    isVendorPayoutSetupOpen(orgId).then(async (railOpen) => ({
      railOpen,
      routing: railOpen ? await getPaymentApprovalRouting(orgId) : null,
    })),
  ])
  if (!project) notFound()
  return <PageLayout title="Payables" breadcrumbs={[
    { label: project.name, href: `/projects/${id}` }, { label: "Payables" },
  ]} fullBleed>
    <FinancialSetupStatusBanner setup={setup} />
    <PayablesDesk key={id} data={data}
      project={{ id, name: project.name, billingModel: setup.billingModel, costCodesEnabled: setup.costCodesEnabled }}
      railOpen={payment.railOpen} viewerMayApproveRuns={Boolean(payment.routing?.viewerMayApprove)}
      approvalViewer={{ userId, approvers: payment.routing?.approvers ?? [] }} />
  </PageLayout>
}
