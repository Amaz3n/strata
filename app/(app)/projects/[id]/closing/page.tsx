import { connection } from "next/server"
import { Suspense } from "react"
import { ProjectInventoryLink } from "@/components/books/project-accounting-tools"
import { notFound } from "next/navigation"

import { ClosingWorkbench } from "@/components/sales/closing-workbench"
import { getClosing } from "@/lib/services/closings"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"


type ClosingPageProps = { params: Promise<{ id: string }> }

export default function ProjectClosingPage(props: ClosingPageProps) {
  return (
    <PageLayout title="Closing">
      <Suspense fallback={
        <div className="space-y-6" role="status" aria-label="Loading closing">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-24" />)}
          </div>
          <Skeleton className="h-64 w-full" />
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
  const detail = await getClosing(id)
  if (!detail) notFound()
  const {getProjectWaiverReadiness}=await import("@/lib/services/waiver-register")
  const waivers=await getProjectWaiverReadiness(id,"sales.read")
  return <><div className="border-b p-4 text-sm"><a className="underline" href={waivers.href}>Final waivers</a> · {waivers.ready?"Ready":`${waivers.missing.length} outstanding`}</div><Suspense fallback={null}><ProjectInventoryLink projectId={id} /></Suspense><ClosingWorkbench key={`${id}:${detail.closing.id}`} projectId={id} detail={detail} /></>
}
