import { notFound } from "next/navigation"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
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

  return (
    <>
      <PageLayout
        title="Proposals"
        breadcrumbs={[
          { label: "Project" },
          { label: "Proposals" },
        ]}
      />
      <Suspense
        fallback={
          <div className="p-6 space-y-4">
            <Skeleton className="h-8 w-48 mb-6" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <ProjectProposalsData id={id} />
      </Suspense>
    </>
  )
}

async function ProjectProposalsData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const proposals = await listProposalsAction()
  const filtered = (proposals ?? []).filter((proposal) => proposal.project_id === project.id)

  return (
    <PageLayout
      title="Proposals"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Proposals" },
      ]}
    >
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
