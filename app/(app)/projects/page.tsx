import { listProjectsAction } from "./actions"
import { ProjectsClient } from "./projects-client"
import { PageLayout } from "@/components/layout/page-layout"

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const projects = await listProjectsAction()

  return (
    <PageLayout title="Projects">
      <div className="space-y-6">
        <ProjectsClient projects={projects} />
      </div>
    </PageLayout>
  )
}
