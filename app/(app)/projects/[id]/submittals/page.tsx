import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listSubmittalsAction } from "@/app/(app)/submittals/actions"
import { SubmittalsClient } from "@/components/submittals/submittals-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectSubmittalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectSubmittalsPage({ params }: ProjectSubmittalsPageProps) {
  const { id } = await params

  const [project, submittals] = await Promise.all([
    getProjectAction(id),
    listSubmittalsAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Submittals">
      <div className="space-y-6">
        <SubmittalsClient submittals={submittals} projects={[project]} />
      </div>
    </PageLayout>
  )
}
