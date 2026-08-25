/**
 * Resolves the direct-to-storage URL a reader should pull bytes from.
 *
 * Every consumer already holds a working URL — `/api/files/{id}/raw` — so this
 * is strictly an optimization: it trades one small JSON request for byte ranges
 * that skip the app entirely. A `null` result means "keep using the URL you
 * have", which is why nothing here throws.
 *
 * Results are cached per file because reopening a document is the common case,
 * and concurrent callers share one in-flight request so a viewer and its
 * thumbnail rail cannot each sign the same file.
 */

interface CachedViewUrl {
  url: string
  /** Epoch ms. Deliberately earlier than the real expiry — see `EXPIRY_MARGIN_MS`. */
  expiresAt: number
}

/**
 * Retire a signed URL early. A document that is still open when the signature
 * lapses starts failing range requests, and re-signing after the fact means
 * re-parsing the file; the margin makes the next open resolve fresh instead.
 */
const EXPIRY_MARGIN_MS = 5 * 60_000

const cache = new Map<string, CachedViewUrl>()
const inflight = new Map<string, Promise<string | null>>()

/**
 * Set once a direct read has actually failed, and never cleared for the life of
 * the tab. Whether direct reads work is a property of the deployment — the
 * bucket's CORS policy has to admit this origin — not of one file, so a single
 * failure is enough to know. Without this, a bucket that rejects the app origin
 * would make every PDF load twice: once against the URL that cannot work, then
 * again through the proxied route.
 */
let directReadsUnavailable = false

export async function resolveFileViewUrl(fileId: string): Promise<string | null> {
  if (directReadsUnavailable) return null

  const cached = cache.get(fileId)
  if (cached && cached.expiresAt > Date.now()) return cached.url

  const existing = inflight.get(fileId)
  if (existing) return existing

  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetch(`/api/files/${fileId}/view-url`, {
        credentials: "same-origin",
      })
      if (!response.ok) return null

      const payload: unknown = await response.json()
      if (!payload || typeof payload !== "object") return null

      const { url, expiresIn } = payload as { url?: unknown; expiresIn?: unknown }
      if (typeof url !== "string" || url.length === 0) return null

      const ttlMs = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 0
      cache.set(fileId, {
        url,
        expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_MARGIN_MS),
      })
      return url
    } catch {
      // Offline, blocked, or the endpoint is unavailable. The caller's existing
      // URL still works, so this is not an error worth surfacing.
      return null
    } finally {
      inflight.delete(fileId)
    }
  })()

  inflight.set(fileId, request)
  return request
}

/**
 * Report that a reader could not fetch a signed URL, and stand the whole
 * mechanism down for this tab.
 *
 * Callers are expected to fall back to their proxied URL, so the cost of
 * giving up is only that reads go back to being what they are today — while
 * the cost of continuing to hand out URLs that cannot be fetched is a doubled
 * load on every document.
 */
export function reportFileViewUrlFailure(fileId: string): void {
  cache.delete(fileId)
  directReadsUnavailable = true
}
