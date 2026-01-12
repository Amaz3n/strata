import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectScheduleAction } from "../actions"
import { ProjectScheduleClient } from "./project-schedule-client"

// export const dynamic = "force-dynamic" // Replaced with revalidate for better caching
export const revalidate = 30 // Revalidate every 30 seconds for schedule updates

interface ProjectSchedulePageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectSchedulePage({ params }: ProjectSchedulePageProps) {
  const { id } = await params

  const [project, scheduleItems] = await Promise.all([
    getProjectAction(id),
    getProjectScheduleAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Schedule">
      <ProjectScheduleClient projectId={project.id} initialItems={scheduleItems} />
    </PageLayout>
  )
}
