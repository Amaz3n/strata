import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listSubmittalsAction } from "@/app/(app)/submittals/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import type { Project } from "@/lib/types"
import { Button } from "@/components/ui/button"

import { unwrapAction } from "@/lib/action-result"
import { listSpecSectionOptions } from "@/lib/services/specs"

interface ProjectSubmittalsPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ submittal?: string }>
}

export default async function ProjectSubmittalsPage({ params, searchParams }: ProjectSubmittalsPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
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
        <ProjectSubmittalsData project={project} initialSubmittalId={query.submittal} />
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

async function ProjectSubmittalsData({ project, initialSubmittalId }: { project: Project; initialSubmittalId?: string }) {
  const [submittals, companies, specSections] = await Promise.all([
    listSubmittalsAction(project.id),
    listCompaniesAction(),
    listSpecSectionOptions(project.id).catch(() => []),
  ])

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><Button variant="outline" asChild><a href={`/projects/${project.id}/exports/submittal-register`} target="_blank" rel="noreferrer">Export register PDF</a></Button></div>
      <SubmittalsClient submittals={submittals} projects={[project]} companies={companies} initialSubmittalId={initialSubmittalId} specSections={specSections} />
    </div>
  )
}
