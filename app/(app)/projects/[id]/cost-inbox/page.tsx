import { redirect } from "next/navigation"

interface Props {
  params: Promise<{ id: string }>
}

export default async function ProjectCostInboxPage({ params }: Props) {
  const { id } = await params
  redirect(`/projects/${id}/financials`)
}
