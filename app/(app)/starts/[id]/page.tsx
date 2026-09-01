import { redirect } from "next/navigation"
export const instant = false

/**
 * Permalink for a start package — notifications and search link here. The
 * package has no page of its own: it opens as a sheet over the release lane so
 * whoever followed the link lands with the week plan still in front of them.
 */
export default async function StartPackagePermalink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const query = new URLSearchParams({ package: id })
  redirect(`/starts?${query}`)
}
