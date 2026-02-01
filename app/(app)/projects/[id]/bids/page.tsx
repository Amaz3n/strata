import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listBidPackagesAction } from "./actions"
import { BidPackagesClient } from "@/components/bids/bid-packages-client"

interface ProjectBidsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectBidsPage({ params }: ProjectBidsPageProps) {
  const { id } = await params

  const [project, packages] = await Promise.all([
    getProjectAction(id),
    listBidPackagesAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Bids"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Bids" },
      ]}
    >
      <BidPackagesClient projectId={project.id} packages={packages} />
    </PageLayout>
  )
}
