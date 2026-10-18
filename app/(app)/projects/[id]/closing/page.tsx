import { connection } from "next/server"
import { Suspense } from "react"
import { ProjectInventoryLink } from "@/components/books/project-accounting-tools"
import { notFound } from "next/navigation"

import { ClosingCommissionsSkeleton } from "@/components/sales/closing-commissions"
import { ClosingCommissionsSection } from "@/components/sales/closing-commissions-section"
import { ClosingWorkbench } from "@/components/sales/closing-workbench"
import { PurchaseAgreementRecord, PurchaseAgreementRecordSkeleton } from "@/components/sales/purchase-agreement-record"
import { getHomeAgreementMilestones } from "@/lib/services/agreement-milestones"
import { getClosing } from "@/lib/services/closings"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { getProjectWaiverReadiness } from "@/lib/services/waiver-register"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"


type ClosingPageProps = { params: Promise<{ id: string }> }

export default function ProjectClosingPage(props: ClosingPageProps) {
  return (
    <PageLayout title="Closing">
      <Suspense fallback={
        <div className="space-y-5 p-4" role="status" aria-label="Loading closing">
          <Skeleton className="h-10 w-full" />
          <div className="space-y-2 border p-4">
            <Skeleton className="h-5 w-56" />
            {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-8 w-full" />)}
          </div>
          <Skeleton className="h-64 w-full" />
          <div className="space-y-2 border p-4">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
          </div>
        </div>
      }>
        <ProjectClosingData {...props} />
      </Suspense>
    </PageLayout>
  )
}

async function ProjectClosingData({ params }: ClosingPageProps) {
  await connection()
  const { id } = await params
  const context = await requireOrgContext()
  // The milestones section reports its own failure; the closing still opens.
  const [detail, waivers, milestones, canManageSale] = await Promise.all([
    getClosing(id, context.orgId),
    getProjectWaiverReadiness(id, "sales.read"),
    getHomeAgreementMilestones(id).then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "Milestones are unavailable" }),
    ),
    hasPermission("sales.manage", { orgId: context.orgId, userId: context.userId, supabase: context.supabase }),
  ])
  if (!detail) notFound()
  const contractId = detail.agreement?.id ? String(detail.agreement.id) : null
  // The slots render among the workbench's own children; Flight can hand them
  // over as lazy references, which only a key keeps out of the list warning.
  return <><div className="border-b p-4 text-sm"><a className="underline" href={waivers.href}>Final waivers</a> · {waivers.ready?"Ready":`${waivers.missing.length} outstanding`}</div><Suspense fallback={null}><ProjectInventoryLink projectId={id} /></Suspense><ClosingWorkbench key={`${id}:${detail.closing.id}`} projectId={id} detail={detail} milestones={milestones} canCancelSale={canManageSale}
    agreementRecord={contractId ? <Suspense key="agreement-record" fallback={<PurchaseAgreementRecordSkeleton />}><PurchaseAgreementRecord contractId={contractId} canManageSale={canManageSale} /></Suspense> : null}
    commissions={<Suspense key="commissions" fallback={<ClosingCommissionsSkeleton />}><ClosingCommissionsSection projectId={id} /></Suspense>} /></>
}
