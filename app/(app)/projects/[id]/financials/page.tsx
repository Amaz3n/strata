import { redirect } from "next/navigation"
export const instant = false

interface ProjectFinancialsPageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string | string[] }>
}

const legacyTabRoutes: Record<string, string> = {
  budget: "financials/budget",
  receivables: "financials/billing",
  billing: "financials/billing",
  payables: "financials/payables",
  "cost-plus": "financials/cost-inbox",
  inbox: "financials/cost-inbox",
  review: "financials/cost-inbox",
  "trust-center": "reports/reconciliation",
}

export default async function ProjectFinancialsLandingPage({ params, searchParams }: ProjectFinancialsPageProps) {
  const { id } = await params
  const { tab } = (await searchParams) ?? {}

  const route = typeof tab === "string" && Object.hasOwn(legacyTabRoutes, tab)
    ? legacyTabRoutes[tab]
    : "financials/billing"
  redirect(`/projects/${id}/${route}`)
}
