import { redirect } from "next/navigation"

/**
 * A person's account lives in the directory shell alongside a company's.
 *
 * This route was the last piece of the split: companies got `/directory/[id]`
 * with real tabs while people got a separate page outside that chrome, so the
 * two halves of one directory never behaved alike. `/directory/[id]` now
 * resolves either kind.
 */
export default async function LegacyContactPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/directory/${id}`)
}
