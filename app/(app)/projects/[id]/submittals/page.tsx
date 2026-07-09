import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listSubmittalsAction } from "@/app/(app)/submittals/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import type { Project } from "@/lib/types"

import { unwrapAction } from "@/lib/action-result"

interface ProjectSubmittalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectSubmittalsPage({ params }: ProjectSubmittalsPageProps) {
  const { id } = await params
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Submittals"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Submittals" },
      ]}
    >
      <Suspense fallback={<ProjectSubmittalsFallback />}>
        <ProjectSubmittalsData project={project} />
      </Suspense>
    </PageLayout>
  )
}

function ProjectSubmittalsFallback() {
  return (
    <div className="space-y-6">
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  )
}

async function ProjectSubmittalsData({ project }: { project: Project }) {
  const [submittals, companies] = await Promise.all([listSubmittalsAction(project.id), listCompaniesAction()])

  return (
    <div className="space-y-6">
      <SubmittalsClient submittals={submittals} projects={[project]} companies={companies} />
    </div>
  )
}
