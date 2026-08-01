import { notFound, redirect } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { Plan3dPanel } from "@/components/plans/plan-3d-panel"
import { getProjectPosture } from "@/lib/product-tier"
import { getFloorplanModel } from "@/lib/services/floorplan-models"
import { getOrgProductTier } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { getProjectAction } from "../../actions"

export const dynamic = "force-dynamic"

/**
 * The walkable model of a custom home.
 *
 * A residential project's floorplan sheets live on its OWN drawing set, so the
 * model is anchored to the project and interpreted from those sheets directly
 * — there is no plan version to indirect through, because there is no plan.
 *
 * Production projects are sent to the plan instead: their drawings ARE the
 * released plan set, one interpretation of which already serves every lot
 * built to it. Anchoring a second model here would describe the same house
 * twice and let the two disagree.
 */
export default async function ProjectFloorplanModelPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const orgTier = await getOrgProductTier()
  const posture = getProjectPosture(project.property_type, orgTier)
  if (posture === "production") {
    redirect(`/projects/${id}/drawings`)
  }

  const [record, canWrite] = await Promise.all([
    getFloorplanModel({ kind: "project", projectId: id }).catch(() => null),
    hasPermission("plan.write"),
  ])

  return (
    <PageLayout
      title="3D model"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Drawings", href: `/projects/${project.id}/drawings` },
        { label: "3D model" },
      ]}
      fullBleed
    >
      <Plan3dPanel
        target={{ kind: "project", projectId: id }}
        title={project.name}
        status={record}
        canWrite={canWrite}
      />
    </PageLayout>
  )
}
