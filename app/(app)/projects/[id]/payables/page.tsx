import { redirect } from "next/navigation"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function PayablesPage({ params }: PageProps) {
  const { id } = await params
  redirect(`/projects/${id}/financials?tab=payables`)
}
