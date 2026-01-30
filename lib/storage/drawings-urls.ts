function normalizeBaseUrl(value?: string | null): string | null {
  if (!value) return null
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function getSupabaseUrl(): string | null {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    null
  )
}

export function getDrawingsImagesBaseUrl(): string | null {
  const override =
    process.env.NEXT_PUBLIC_DRAWINGS_IMAGES_BASE_URL ??
    process.env.DRAWINGS_IMAGES_BASE_URL
  if (override) return normalizeBaseUrl(override)

  const supabaseUrl = getSupabaseUrl()
  if (!supabaseUrl) return null
  return normalizeBaseUrl(
    `${supabaseUrl}/storage/v1/object/public/drawings-images`
  )
}

export function getDrawingsTilesBaseUrl(): string | null {
  const override =
    process.env.NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL ??
    process.env.DRAWINGS_TILES_BASE_URL
  if (override) return normalizeBaseUrl(override)

  const supabaseUrl = getSupabaseUrl()
  if (!supabaseUrl) return null
  return normalizeBaseUrl(
    `${supabaseUrl}/storage/v1/object/public/drawings-tiles`
  )
}

export function buildDrawingsImageUrl(path?: string | null): string | null {
  if (!path) return null
  const baseUrl = getDrawingsImagesBaseUrl()
  if (!baseUrl) return null
  const normalized = path.startsWith("/") ? path.slice(1) : path
  return `${baseUrl}/${encodeURI(normalized)}`
}

export function buildDrawingsTilesBaseUrl(basePath: string): string | null {
  const baseUrl = getDrawingsTilesBaseUrl()
  if (!baseUrl) return null
  const normalized = basePath.startsWith("/") ? basePath.slice(1) : basePath
  return `${baseUrl}/${normalized}`
}
