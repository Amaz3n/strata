import { redirect } from "next/navigation"

// Compatibility redirect; the billing destination owns its navigation contract.
export const instant = false

export default async function LegacyInvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry))
    else if (value) query.set(key, value)
  }
  redirect(query.size > 0 ? `/billing?${query.toString()}` : "/billing")
}
