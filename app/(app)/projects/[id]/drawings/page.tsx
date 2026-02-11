import { redirect } from "next/navigation"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDrawingsPage({ params }: ProjectDrawingsPageProps) {
  const { id } = await params
  redirect(`/projects/${id}/files?tab=drawings`)
}
