/**
 * Drawings CDN url rewriting, shared by every client that loads tiles.
 *
 * Raw cdn.arcnaples.com urls are auth-protected and 401 anywhere but the
 * production host (localhost, previews), so off-host we route them through the
 * authenticated /api/drawings/tiles proxy. Client-safe: no server imports.
 */

const TILE_PATH_MARKER = "/drawings-tiles/"

export function isSecureDrawingsTilesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true"
}

export function buildRenderableTileBaseUrl(
  baseUrl: string,
  secureTilesEnabled: boolean = isSecureDrawingsTilesEnabled(),
): string {
  if (typeof window === "undefined") return baseUrl
  if (!secureTilesEnabled) return baseUrl

  const host = window.location.hostname.toLowerCase()
  const isProductionAppHost =
    host === "app.arcnaples.com" || host.endsWith(".arcnaples.com")

  if (isProductionAppHost) return baseUrl

  try {
    const parsed = new URL(baseUrl)
    const index = parsed.pathname.indexOf(TILE_PATH_MARKER)
    if (index === -1) return baseUrl
    const path = parsed.pathname.slice(index + TILE_PATH_MARKER.length)
    return `/api/drawings/tiles/${path}`
  } catch {
    return baseUrl
  }
}

/**
 * Convert a raw drawings CDN url (tile base, thumbnail.png, etc.) into a URL the
 * browser can actually load.
 */
export function toRenderableDrawingsUrl(
  url?: string | null,
): string | undefined {
  if (!url) return undefined
  return buildRenderableTileBaseUrl(url, isSecureDrawingsTilesEnabled())
}
