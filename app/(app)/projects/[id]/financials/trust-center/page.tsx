import { guardProjectTab } from "@/lib/services/workspace-surface"
import { redirect } from "next/navigation"
export const instant = false


interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsTrustCenterPage({ params }: PageProps) {
  const { id } = await params
  await guardProjectTab(id, "trust_center")
  redirect(`/projects/${id}/reports/reconciliation`)
}
