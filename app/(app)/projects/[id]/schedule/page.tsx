import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectScheduleAction } from "../actions"
import { ProjectScheduleClient } from "./project-schedule-client"

import { unwrapAction } from "@/lib/action-result"

interface ProjectSchedulePageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectSchedulePage({ params }: ProjectSchedulePageProps) {
  const { id } = await params

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
        <ProjectScheduleData id={id} />
      </Suspense>
    </>
  )
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

  const scheduleItems = await getProjectScheduleAction(id)

  return (
    <PageLayout
      title="Schedule"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Schedule" },
      ]}
    >
      <ProjectScheduleClient projectId={project.id} initialItems={scheduleItems} />
    </PageLayout>
  )
}
