import { redirect } from "next/navigation"

interface ProjectProposalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectProposalsPage({ params }: ProjectProposalsPageProps) {
  const { id } = await params
  redirect(`/projects/${id}/signatures`)
}
