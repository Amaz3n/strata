import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"

/**
 * Every control on the log writes to the URL and nothing else.
 *
 * The workbench holds no filter or selection state of its own: the server has
 * already parsed the query string into `filters` and loaded the open
 * conversation from it, so the client only ever needs to say what the *next*
 * URL is. That is also why nothing here reads `useSearchParams()` — a client
 * component reading URL data outside a Suspense boundary blocks the route's
 * prerender, which is what the old page did.
 */
export interface CorrespondenceUrlChanges {
  q?: string | null
  classification?: string | null
  direction?: string | null
  review?: string | null
  attachments?: string | null
  linked?: string | null
  from?: string | null
  to?: string | null
  view?: string | null
  page?: string | null
  email?: string | null
  thread?: string | null
}

/** The query string that reproduces the view currently on screen. */
export function correspondenceParams(filters: CorrespondenceFilterInput): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.status === "unfiled") params.set("view", "unfiled")
  if (filters.search) params.set("q", filters.search)
  if (filters.classification) params.set("classification", filters.classification)
  if (filters.direction) params.set("direction", filters.direction)
  if (filters.needsReview) params.set("review", "1")
  if (filters.hasAttachments) params.set("attachments", "1")
  if (filters.linked) params.set("linked", filters.linked)
  if (filters.from) params.set("from", filters.from)
  if (filters.to) params.set("to", filters.to)
  if (filters.page > 1) params.set("page", String(filters.page))
  return params
}

export function correspondenceHref(
  projectId: string,
  filters: CorrespondenceFilterInput,
  changes: CorrespondenceUrlChanges = {},
): string {
  const params = correspondenceParams(filters)
  for (const [key, value] of Object.entries(changes)) {
    // `undefined` leaves a parameter alone; `null` removes it. Without that
    // distinction there is no way to change one filter and keep the rest.
    if (value === undefined) continue
    if (value === null || value === "") params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  return query ? `/projects/${projectId}/correspondence?${query}` : `/projects/${projectId}/correspondence`
}

/**
 * A filter change starts a new result set, so the page and the open
 * conversation both go with it — otherwise page 4 of the old filter renders
 * empty and the reader keeps showing mail the list no longer contains.
 */
export function correspondenceFilterHref(
  projectId: string,
  filters: CorrespondenceFilterInput,
  changes: CorrespondenceUrlChanges,
): string {
  return correspondenceHref(projectId, filters, { ...changes, page: null, email: null, thread: null })
}

/** True when anything other than the pile being read is narrowing the list. */
export function activeFilterCount(filters: CorrespondenceFilterInput): number {
  return [
    filters.classification,
    filters.direction,
    filters.linked,
    filters.from,
    filters.to,
    filters.needsReview ? "1" : null,
    filters.hasAttachments ? "1" : null,
  ].filter(Boolean).length
}
