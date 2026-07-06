import { redirect } from "next/navigation"

interface ProjectTasksPageProps {
  params: Promise<{ id: string }>
}

// Tasks are now managed org-wide on /tasks (personal cross-project hub). Keep this
// route as a redirect so existing deep-links land on the org page, filtered to the
// project.
export default async function ProjectTasksPage({ params }: ProjectTasksPageProps) {
  const { id } = await params
  redirect(`/tasks?project=${id}`)
}
