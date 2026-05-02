import { listProjectsAction } from "./actions"
import { ProjectsClient } from "./projects-client"
import { PageLayout } from "@/components/layout/page-layout"

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const projects = await listProjectsAction()

  return (
    <PageLayout title="Projects">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <ProjectsClient projects={projects} />
      </div>
    </PageLayout>
  )
}
