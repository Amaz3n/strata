import { redirect } from "next/navigation"
export const instant = false

interface ProjectFinancialsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string }>
}

const legacyTabRoutes: Record<string, string> = {
  budget: "budget",
  receivables: "billing",
  billing: "billing",
  payables: "payables",
  "cost-plus": "cost-inbox",
  inbox: "cost-inbox",
  review: "cost-inbox",
  "trust-center": "trust-center",
}

export default async function ProjectFinancialsLandingPage({ params, searchParams }: ProjectFinancialsPageProps) {
  const { id } = await params
  const { tab } = (await searchParams) ?? {}

  if (tab && legacyTabRoutes[tab]) {
    redirect(`/projects/${id}/financials/${legacyTabRoutes[tab]}`)
  }

  redirect(`/projects/${id}/financials/billing`)
}
