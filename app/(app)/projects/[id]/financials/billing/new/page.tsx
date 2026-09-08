import { redirect } from "next/navigation"

import { newInvoiceHref, resumeInvoiceHref, type NewInvoiceKind } from "@/lib/financials/invoice-destinations"

export const instant = false

interface PageProps {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ draft?: string; duplicate?: string; source?: string; customer?: string; kind?: string }>
}

/**
 * Legacy route. The composer opens over the billing book now, so links that
 * were sent while it had a route of its own land in the same place.
 */
export default async function NewInvoicePage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = (await searchParams) ?? {}
  if (query.draft) redirect(resumeInvoiceHref(id, query.draft))
  const kind: NewInvoiceKind | undefined =
    query.kind === "earnest_deposit" || query.kind === "closing" ? query.kind : undefined
  redirect(
    newInvoiceHref(id, {
      duplicateOf: query.duplicate,
      sourceChangeOrderId: query.source?.startsWith("change_order:") ? query.source.slice("change_order:".length) : undefined,
      customerId: query.customer,
      kind,
    }),
  )
}
