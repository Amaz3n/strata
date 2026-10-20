import { guardProjectTab } from "@/lib/services/workspace-surface"
import { redirect } from "next/navigation"
export const instant = false

interface ProjectProposalsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectProposalsPage({ params }: ProjectProposalsPageProps) {
  const { id } = await params
  await guardProjectTab(id, "proposals")
  redirect(`/projects/${id}/signatures`)
}
