import { notFound, redirect } from "next/navigation"
import { getProjectAction } from "../actions"

interface ProjectMessagesPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMessagesPage({ params }: ProjectMessagesPageProps) {
  const { id } = await params

  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }
  redirect("/messages")
}
