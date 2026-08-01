/**
 * Responsive sources for files that went through the preview ladder.
 *
 * The preview route negotiates WebP vs AVIF from the request's Accept header,
 * so one URL per width is enough — no `<picture>`/`type` plumbing needed here.
 */

/** Must match PREVIEW_LADDER_WIDTHS in the outbox preview job. */
export const PREVIEW_LADDER_WIDTHS = [320, 960, 2048] as const

export interface PreviewMetadata {
  width?: number | null
  height?: number | null
  thumbhash?: string | null
  sizes?: Array<{ width: number; path: string; content_type: string }> | null
}

export function previewUrl(fileId: string, width?: number): string {
  return width ? `/api/files/${fileId}/preview?w=${width}` : `/api/files/${fileId}/preview`
}

/**
 * `srcset` across whatever rungs the file actually has. Returns null when the
 * file predates the ladder, in which case callers use `previewUrl()` alone.
 */
export function photoSrcSet(fileId: string, preview?: PreviewMetadata | null): string | null {
  const available = preview?.sizes
  if (!available || available.length === 0) return null

  const widths = [...new Set(available.map((entry) => entry.width))].sort((a, b) => a - b)
  if (widths.length === 0) return null

  return widths.map((width) => `${previewUrl(fileId, width)} ${width}w`).join(", ")
}

/** `width / height` for aspect-ratio reservation; null when dimensions are unknown. */
export function previewAspectRatio(preview?: PreviewMetadata | null): number | null {
  const width = preview?.width
  const height = preview?.height
  if (!width || !height || width <= 0 || height <= 0) return null
  return width / height
}
