import { redirect } from "next/navigation"
export const instant = false
interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FinancialsCostPlusPage({ params }: PageProps) {
  const { id } = await params
  redirect(`/projects/${id}/financials/review`)
}
