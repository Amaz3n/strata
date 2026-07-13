import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { SpecsRegisterClient } from "@/components/specs/specs-register-client"
import { getProjectAction } from "../actions"
import { listSpecSections, listSpecUploads } from "@/lib/services/specs"
import { hasPermission } from "@/lib/services/permissions"

export default async function ProjectSpecsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
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
        projectId={id}
        initialSections={sections}
        initialUploads={uploads}
        initialSectionId={query.section}
        canWrite={canWrite}
      />
    </PageLayout>
  )
}
