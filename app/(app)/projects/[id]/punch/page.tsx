import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectTeamAction, listProjectPunchItemsAction } from "../actions"
import { ProjectPunchClient } from "./project-punch-client"

import { unwrapAction } from "@/lib/action-result"

interface ProjectPunchPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPunchPage({ params }: ProjectPunchPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Punch"
        breadcrumbs={[
          { label: "Project" },
          { label: "Punch" },
        ]}
      />
      <Suspense fallback={<ProjectPunchFallback />}>
        <ProjectPunchData id={id} />
      </Suspense>
    </>
  )
}

function ProjectPunchFallback() {
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

async function ProjectPunchData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [team, punchItems] = await Promise.all([
    getProjectTeamAction(id),
    listProjectPunchItemsAction(id),
  ])

  return (
    <div className="space-y-6">
      <ProjectPunchClient projectId={project.id} initialItems={punchItems} team={team} />
    </div>
  )
}
