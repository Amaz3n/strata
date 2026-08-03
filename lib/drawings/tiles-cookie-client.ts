/**
 * Tiles access cookie, shared by every client that loads drawing tiles.
 *
 * Tiles are served from the CDN behind a short-lived HMAC cookie rather than
 * per-tile signed urls. Minting it costs a round trip, so the first sheet open
 * used to pay for it before a single tile moved — the register warms it on
 * intent (hover/focus) instead.
 *
 * Memoized per endpoint: the authed app and the token-authenticated portals
 * mint the same cookie from different routes. Client-safe: no server imports.
 */

export const DEFAULT_TILES_COOKIE_ENDPOINT = "/api/drawings/tiles-cookie"

export const TILES_COOKIE_REFRESH_MS = 45 * 60 * 1000

/**
 * If tile loads fail while the cookie is younger than this, the failure is
 * almost certainly not auth expiry — skip the recovery round trip.
 */
export const TILES_COOKIE_FRESH_MS = 60 * 1000

type TilesCookieState = { promise: Promise<void> | null; setAt: number }

const tilesCookieStates = new Map<string, TilesCookieState>()

export function getTilesCookieState(endpoint: string): TilesCookieState {
  let state = tilesCookieStates.get(endpoint)
  if (!state) {
    state = { promise: null, setAt: 0 }
    tilesCookieStates.set(endpoint, state)
  }
  return state
}

export function ensureTilesCookie(
  endpoint: string,
  options?: { force?: boolean }
): Promise<void> {
  const state = getTilesCookieState(endpoint)
  if (!options?.force && state.promise) return state.promise

  const promise = fetch(endpoint, {
    method: "POST",
    credentials: "include",
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to set tiles cookie: HTTP ${response.status}`)
      }
      state.setAt = Date.now()
    })
    .catch((error) => {
      // Allow the next caller to retry instead of caching the failure forever.
      if (state.promise === promise) state.promise = null
      throw error
    })

  state.promise = promise
  return promise
}

/**
 * Warm the cookie ahead of a sheet open. Fire-and-forget by design: a failure
 * here costs nothing because the viewer mints on mount anyway.
 */
export function prefetchTilesCookie(
  endpoint: string = DEFAULT_TILES_COOKIE_ENDPOINT
): void {
  if (typeof window === "undefined") return
  void ensureTilesCookie(endpoint).catch(() => {})
}
