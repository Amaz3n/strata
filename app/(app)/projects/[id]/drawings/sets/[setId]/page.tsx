import { redirect } from "next/navigation"

interface ProjectDrawingSetRedirectPageProps {
  params: Promise<{ id: string; setId: string }>
}

export default async function ProjectDrawingSetRedirectPage({
  params,
}: ProjectDrawingSetRedirectPageProps) {
  const { id, setId } = await params
  redirect(`/projects/${id}/drawings?set=${setId}`)
}
