import { redirect } from "next/navigation"

// Compatibility redirect; the destination owns its navigation contract.
export const instant = false

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string>>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  redirect(
    `/projects/${id}/financials/payables/waivers?${new URLSearchParams(query)}`,
  )
}
