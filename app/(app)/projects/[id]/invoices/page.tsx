import { redirect } from "next/navigation"

// Compatibility redirect; the destination owns its navigation contract.
export const instant = false


interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Legacy route, kept for bookmarks and links already sent in email.
 *
 * It has to carry the query across. It used to drop it, so the retainage
 * ledger's "open this invoice" link — which pointed here with `?open=<id>` —
 * landed on the billing page with nothing selected and no explanation. In-repo
 * links are all built by lib/financials/invoice-destinations.ts now; this is
 * only for the ones already out in the world, including the `?open=` spelling.
 */
export default async function InvoicesPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries((await searchParams) ?? {})) {
    const first = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined
    if (!first) continue
    query.set(key === "open" || key === "invoiceId" ? "invoice" : key, first)
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  redirect(`/projects/${id}/financials/billing${suffix}`)
}
