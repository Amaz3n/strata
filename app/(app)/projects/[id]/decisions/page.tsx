import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listDecisionsAction } from "@/app/(app)/decisions/actions"
import { DecisionsClient } from "@/components/decisions/decisions-client"
import { Skeleton } from "@/components/ui/skeleton"

import { unwrapAction } from "@/lib/action-result"

interface ProjectDecisionsPageProps {
  params: Promise<{ id: string }>
}

export default function ProjectDecisionsPage({ params }: ProjectDecisionsPageProps) {
  return (
    <>
      <PageLayout title="Decisions" breadcrumbs={[
        { label: "Project" },
        { label: "Decisions" },
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
        <ProjectDecisionsPageRoute params={params} />
      </Suspense>
    </>
  )
}

async function ProjectDecisionsPageRoute({ params }: ProjectDecisionsPageProps) {
  await connection()
  const { id } = await params
  await guardProjectTab(id, "decisions")

  return <ProjectDecisionsData id={id} />
}

async function ProjectDecisionsData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const decisions = await listDecisionsAction(id)

  return (
    <PageLayout title="Decisions" breadcrumbs={[
      { label: project.name, href: `/projects/${project.id}` },
      { label: "Decisions" },
    ]}>
      <div className="space-y-6">
        <DecisionsClient projectId={project.id} decisions={decisions} />
      </div>
    </PageLayout>
  )
}
