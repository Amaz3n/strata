import { redirect } from "next/navigation"

interface ProjectFinancialsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string }>
}

const legacyTabRoutes: Record<string, string> = {
  budget: "budget",
  receivables: "receivables",
  payables: "payables",
  "cost-plus": "review",
  inbox: "review",
  review: "review",
}

export default async function ProjectFinancialsLandingPage({ params, searchParams }: ProjectFinancialsPageProps) {
  const { id } = await params
  const { tab } = (await searchParams) ?? {}

  if (tab && legacyTabRoutes[tab]) {
    redirect(`/projects/${id}/financials/${legacyTabRoutes[tab]}`)
  }

  redirect(`/projects/${id}/financials/receivables`)
}
