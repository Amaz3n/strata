import Link from "next/link"

/** URL-backed pagination preserves filters and works before hydration. */
export function QueuePagination({ page, pageSize, total, href, pageParam = "page", label = "Pagination" }: {
  page: number
  pageSize: number
  total: number
  href: string
  pageParam?: string
  label?: string
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const pageHref = (next: number) => {
    const [path, search] = href.split("?")
    const params = new URLSearchParams(search)
    params.set(pageParam, String(next))
    return `${path}?${params}`
  }
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-4 border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground">Page {page} of {pages} · {total} records</span>
      <div className="flex gap-4">
        {page > 1 && <Link prefetch href={pageHref(Math.min(page - 1, pages))}>Previous</Link>}
        {page < pages && <Link prefetch href={pageHref(page + 1)}>Next</Link>}
      </div>
    </nav>
  )
}
