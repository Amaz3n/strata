import { redirect } from "next/navigation"
export const instant = false

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ period?: string }>
}

export default async function FinancialsClosePage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { period } = (await searchParams) ?? {}
  redirect(`/projects/${id}/financials/receivables?tab=close${period ? `&period=${encodeURIComponent(period)}` : ""}`)
}
