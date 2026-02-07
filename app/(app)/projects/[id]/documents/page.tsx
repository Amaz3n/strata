import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listSignaturesHubAction } from "@/app/(app)/documents/actions"
import { SignaturesHubClient } from "@/components/esign/signatures-hub-client"

interface ProjectDocumentsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDocumentsPage({ params }: ProjectDocumentsPageProps) {
  const { id } = await params

  const [project, data] = await Promise.all([
    getProjectAction(id),
    listSignaturesHubAction({ projectId: id }),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Project Signatures">
      <div className="px-6 py-4 h-full">
        <SignaturesHubClient initialData={data} scope="project" />
      </div>
    </PageLayout>
  )
}
