import { redirect } from "next/navigation"

/**
 * The 3D model is a view of the drawings workspace now, beside the sheets it
 * is traced from. Old links land there with the model open.
 */
export default async function ProjectFloorplanModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/projects/${id}/drawings?view=3d`)
}
