import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { getCloseoutPackageAction, getProjectCloseReadinessAction } from "@/app/(app)/closeout/actions"
import { CloseoutClient } from "@/components/closeout/closeout-client"
import { GmpSavingsSettlementPanel } from "@/components/closeout/gmp-savings-settlement-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { getProjectGmpControlSummary } from "@/lib/services/gmp-control"

import { authorize } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

interface ProjectCloseoutPageProps {
  params: Promise<{ id: string }>
}

export default function ProjectCloseoutPage({ params }: ProjectCloseoutPageProps) {
  return (
    <>
      <PageLayout title="Closeout" breadcrumbs={[
        { label: "Project" },
        { label: "Closeout" },
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
        <ProjectCloseoutPageRoute params={params} />
      </Suspense>
    </>
  )
}

async function ProjectCloseoutPageRoute({ params }: ProjectCloseoutPageProps) {
  await connection()
  const { id } = await params

  return <ProjectCloseoutData id={id} />
}

async function ProjectCloseoutData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) notFound()

  const context = await requireOrgContext()
  const [closeout, readiness, gmpSummary, writeDecision, orgMember] = await Promise.all([
    getCloseoutPackageAction(id),
    getProjectCloseReadinessAction(id),
    getProjectGmpControlSummary(id),
    authorize({ ...context, permission: "closeout.write", projectId: id, logDecision: false }),
    hasPermission("org.member"),
  ])

  return (
    <div className="space-y-6">
      {gmpSummary?.enabled ? (
        <GmpSavingsSettlementPanel projectId={project.id} projectStatus={project.status} summary={gmpSummary} />
      ) : null}
      <CloseoutClient projectId={project.id} closeoutPackage={closeout.package} preparationRequired={closeout.preparationRequired} canWrite={orgMember && writeDecision.allowed} items={closeout.items} readiness={readiness} />
    </div>
  )
}
