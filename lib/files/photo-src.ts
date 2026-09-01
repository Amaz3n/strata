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
  /**
   * The rungs this file actually has. Only the width is read — a caller holding
   * the stored `sizes` objects can pass them as they are, and one that only
   * knows the widths can say so without inventing the rest.
   */
  sizes?: Array<{ width: number }> | null
}

export function previewUrl(fileId: string, width?: number): string {
  return width ? `/api/files/${fileId}/preview?w=${width}` : `/api/files/${fileId}/preview`
}

/** `srcset` across a known set of rung widths. */
export function photoSrcSetFromWidths(fileId: string, widths?: number[] | null): string | null {
  if (!widths || widths.length === 0) return null
  const sorted = [...new Set(widths)].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted.map((width) => `${previewUrl(fileId, width)} ${width}w`).join(", ")
}

/**
 * `srcset` across whatever rungs the file actually has. Returns null when the
 * file predates the ladder, in which case callers use `previewUrl()` alone.
 */
export function photoSrcSet(fileId: string, preview?: PreviewMetadata | null): string | null {
  return photoSrcSetFromWidths(fileId, preview?.sizes?.map((entry) => entry.width))
}

/** `width / height` for aspect-ratio reservation; null when dimensions are unknown. */
export function previewAspectRatio(preview?: PreviewMetadata | null): number | null {
  const width = preview?.width
  const height = preview?.height
  if (!width || !height || width <= 0 || height <= 0) return null
  return width / height
}
