import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listRfisAction } from "@/app/(app)/rfis/actions"
import { RfisClient } from "@/components/rfis/rfis-client"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { listContactsAction } from "@/app/(app)/contacts/actions"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectRfisPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectRfisPage({ params }: ProjectRfisPageProps) {
  const { id } = await params

  const [project, rfis, companies, contacts] = await Promise.all([
    getProjectAction(id),
    listRfisAction(id),
    listCompaniesAction(),
    listContactsAction(),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="RFIs"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "RFIs" },
      ]}
    >
      <div className="space-y-6">
        <RfisClient rfis={rfis} projects={[project]} companies={companies} contacts={contacts} />
      </div>
    </PageLayout>
  )
}
