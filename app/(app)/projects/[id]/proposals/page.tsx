import { redirect } from "next/navigation"
export const instant = false

interface ProjectProposalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectProposalsPage({ params }: ProjectProposalsPageProps) {
  const { id } = await params
  redirect(`/projects/${id}/signatures`)
}
