import { guardProjectTab } from "@/lib/services/workspace-surface"
import { redirect } from "next/navigation"
export const instant = false
interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsCostPlusPage({ params }: PageProps) {
  const { id } = await params
  await guardProjectTab(id, "cost_plus")
  redirect(`/projects/${id}/financials/cost-inbox`)
}
