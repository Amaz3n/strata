import { notFound, redirect } from "next/navigation"

import { isProjectModelEnabled } from "@/lib/project-model-access"
import { getProjectAction } from "../../actions"

/**
 * The 3D model is a view of the drawings workspace now, beside the sheets it
 * is traced from. Old links land there with the model open — except where the
 * model is withheld from an organization, which lands on the sheets.
 */
export default async function ProjectFloorplanModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()
  redirect(isProjectModelEnabled(project.org_id) ? `/projects/${id}/drawings?view=3d` : `/projects/${id}/drawings`)
}
