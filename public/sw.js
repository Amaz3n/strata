const TILE_CACHE = "drawing-tiles-v1"
const METADATA_CACHE = "drawing-metadata-v1"

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)

  // Tile requests: cache-first, immutable
  if (url.pathname.includes("/drawings-tiles/") || url.pathname.includes("/drawing-tiles/")) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached
          return fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone())
            return response
          })
        })
      )
    )
    return
  }

  // Metadata requests: network-first with cache fallback
  if (url.pathname.includes("/api/drawings/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone()
          caches.open(METADATA_CACHE).then((cache) => cache.put(event.request, clone))
          return response
        })
        .catch(() => caches.match(event.request))
    )
  }
})
