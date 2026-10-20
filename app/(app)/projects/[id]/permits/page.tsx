import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PermitsSkeleton } from "@/components/permits/permits-skeleton"
import { PermitsWorkbench } from "@/components/permits/permits-workbench"
import { getProjectPermits } from "@/lib/services/permits"

type PermitsPageProps = { params: Promise<{ id: string }> }

export default function ProjectPermitsPage(props: PermitsPageProps) {
  return (
    <PageLayout title="Permits">
      <Suspense fallback={<PermitsSkeleton />}>
        <ProjectPermitsData {...props} />
      </Suspense>
    </PageLayout>
  )
}

async function ProjectPermitsData({ params }: PermitsPageProps) {
  await connection()
  const { id } = await params
  await guardProjectTab(id, "permits")
  return <PermitsWorkbench data={await getProjectPermits(id)} />
}
