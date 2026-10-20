import { guardProjectTab } from "@/lib/services/workspace-surface"
import { redirect } from "next/navigation"
export const instant = false

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CommitmentsPage({ params }: PageProps) {
  const { id } = await params
  await guardProjectTab(id, "commitments")
  redirect(`/projects/${id}/financials/budget`)
}
