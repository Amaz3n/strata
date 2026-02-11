import { redirect } from "next/navigation"

interface ProjectDrawingSetPageProps {
  params: Promise<{ id: string; setId: string }>
}

export default async function ProjectDrawingSetPage({ params }: ProjectDrawingSetPageProps) {
  const { id, setId } = await params
  redirect(`/projects/${id}/files?tab=drawings&setId=${setId}`)
}
