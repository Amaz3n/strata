import { redirect } from "next/navigation"

import { projectBillingPeriodHref } from "@/lib/financials/invoice-destinations"

export const instant = false

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ period?: string }>
}

/** Legacy route. Period close lives in the billing book's Up next band now. */
export default async function FinancialsClosePage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { period } = (await searchParams) ?? {}
  redirect(projectBillingPeriodHref(id, period ?? null))
}
