import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation"

import { loadSelectionsBuilderAction } from "@/app/(app)/selections/actions"
import { SelectionsBuilderClient } from "@/components/selections/selections-client"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"

interface PageProps {
  params: Promise<{ id: string }>
}

async function ProjectSelectionsPageContent({ params }: PageProps) {
  await connection()
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()
  const data = await loadSelectionsBuilderAction(id)

  return (
    <PageLayout
      title="Selections"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Selections" }]}
      fullBleed
    >
      <SelectionsBuilderClient data={data} projects={[project]} />
    </PageLayout>
  )
}

export default function ProjectSelectionsPage(props: Parameters<typeof ProjectSelectionsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Selections" fullBleed>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <ProjectSelectionsPageContent {...props} />
    </Suspense>
  )
}
