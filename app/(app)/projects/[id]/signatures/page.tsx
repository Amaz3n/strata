import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listSignaturesHubAction } from "@/app/(app)/signatures/actions"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"

import { unwrapAction } from "@/lib/action-result"

interface ProjectDocumentsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDocumentsPage({ params }: ProjectDocumentsPageProps) {
  const { id } = await params
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Project Signatures"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Signatures" },
      ]}
    >
      <Suspense fallback={<ProjectSignaturesFallback />}>
        <ProjectSignaturesData project={project} />
      </Suspense>
    </PageLayout>
  )
}

function ProjectSignaturesFallback() {
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

async function ProjectSignaturesData({ project }: { project: any }) {
  const data = await listSignaturesHubAction({ projectId: project.id })

  return (
    <SignaturesHubClient
      initialData={data}
      scope="project"
      projectsForNewEnvelope={[{ id: project.id, name: project.name }]}
    />
  )
}
