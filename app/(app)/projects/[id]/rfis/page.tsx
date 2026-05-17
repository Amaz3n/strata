import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listRfisAction } from "@/app/(app)/rfis/actions"
import { RfisClient } from "@/components/rfis/rfis-client"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { listContactsAction } from "@/app/(app)/contacts/actions"

interface ProjectRfisPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectRfisPage({ params }: ProjectRfisPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="RFIs"
        breadcrumbs={[
          { label: "Project" },
          { label: "RFIs" },
        ]}
      />
      <Suspense fallback={<ProjectRfisFallback />}>
        <ProjectRfisData id={id} />
      </Suspense>
    </>
  )
}

function ProjectRfisFallback() {
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

async function ProjectRfisData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [rfis, companies, contacts] = await Promise.all([
    listRfisAction(id),
    listCompaniesAction(),
    listContactsAction(),
  ])

  return (
    <PageLayout
      title="RFIs"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "RFIs" },
      ]}
    >
      <RfisClient rfis={rfis} projects={[project]} companies={companies} contacts={contacts} />
    </PageLayout>
  )
}
