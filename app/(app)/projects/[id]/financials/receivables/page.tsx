import { redirect } from "next/navigation"
export const instant = false

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function FinancialsReceivablesPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries((await searchParams) ?? {})) {
    if (typeof value === "string") query.set(key, value)
    else if (Array.isArray(value) && value[0]) query.set(key, value[0])
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  redirect(`/projects/${id}/financials/billing${suffix}`)
}
