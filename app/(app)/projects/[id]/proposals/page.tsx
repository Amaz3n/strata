import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listProposalsAction } from "@/app/(app)/proposals/actions"
import { ProposalsClient } from "@/components/proposals/proposals-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectProposalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectProposalsPage({ params }: ProjectProposalsPageProps) {
  const { id } = await params

  const [project, proposals] = await Promise.all([
    getProjectAction(id),
    listProposalsAction(),
  ])

  if (!project) {
    notFound()
  }

  const filtered = (proposals ?? []).filter((proposal) => proposal.project_id === project.id)

  return (
    <PageLayout title="Proposals">
      <div className="space-y-6">
        <ProposalsClient
          proposals={filtered}
          projects={[project]}
          allowNoProject={false}
          hideAllProjectsFilter
        />
      </div>
    </PageLayout>
  )
}
