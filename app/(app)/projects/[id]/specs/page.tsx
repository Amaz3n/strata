import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"

import { PageLayout } from "@/components/layout/page-layout"
import { SpecsRegisterClient } from "@/components/specs/specs-register-client"
import { getProjectAction } from "../actions"
import { listSpecSections, listSpecUploads } from "@/lib/services/specs"
import { hasPermission } from "@/lib/services/permissions"

async function ProjectSpecsContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string }>
}) {
  await connection()
  const [{ id }, query] = await Promise.all([params, searchParams])
  await guardProjectTab(id, "specs")
  const project = await getProjectAction(id)
  if (!project) notFound()

  const [sections, uploads, canWrite] = await Promise.all([
    listSpecSections(id),
    listSpecUploads(id),
    hasPermission("spec.write"),
  ])

  return (
    <PageLayout
      title="Specifications"
      breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Specifications" }]}
      fullBleed
    >
      <SpecsRegisterClient
        key={`${id}:${query.section ?? ""}`}
        projectId={id}
        initialSections={sections}
        initialUploads={uploads}
        initialSectionId={query.section}
        canWrite={canWrite}
      />
    </PageLayout>
  )
}

export default function ProjectSpecsPage(props: Parameters<typeof ProjectSpecsContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Specifications" fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <ProjectSpecsContent {...props} />
    </Suspense>
  )
}
