import { connection } from "next/server"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectDependenciesAction, getProjectScheduleAction } from "../actions"
import { ProjectScheduleClient } from "./project-schedule-client"
import { DeliveryAdvisoryBanner, DeliveryAdvisoryBannerSkeleton } from "@/components/schedule/delivery-advisory-banner"

import { unwrapAction } from "@/lib/action-result"

interface ProjectSchedulePageProps {
  params: Promise<{ id: string }>
}

export default function ProjectSchedulePage({ params }: ProjectSchedulePageProps) {
  return (
    <>
      <PageLayout
        title="Schedule"
        breadcrumbs={[
          { label: "Project" },
          { label: "Schedule" },
        ]}
      />
      <Suspense fallback={<ProjectScheduleFallback />}>
        <ProjectSchedulePageRoute params={params} />
      </Suspense>
    </>
  )
}

async function ProjectSchedulePageRoute({ params }: ProjectSchedulePageProps) {
  await connection()
  const { id } = await params

  return <ProjectScheduleData id={id} />
}

function ProjectScheduleFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

async function ProjectScheduleData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [scheduleItems, dependencies] = await Promise.all([getProjectScheduleAction(id), getProjectDependenciesAction(id)])

  return (
    <PageLayout
      title="Schedule"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Schedule" },
      ]}
    >
      <ProjectScheduleClient projectId={project.id} initialItems={scheduleItems} initialDependencies={dependencies}
        banner={<Suspense key="delivery-advisories" fallback={<DeliveryAdvisoryBannerSkeleton />}><DeliveryAdvisoryBanner projectId={project.id} /></Suspense>} />
    </PageLayout>
  )
}
