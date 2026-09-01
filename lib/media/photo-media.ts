/**
 * What counts as a photo.
 *
 * This predicate has a twin in SQL: `tg_files_ensure_photo_record()` decides
 * which files get a `photos` row using `mime_type like 'image/%' or 'video/%'`,
 * and `project_photo_entries` derives `media_kind` the same way. The two must
 * agree — a file this says yes to but the trigger says no to would be a photo the
 * workbench can never show.
 */

export function isPhotoMedia(mimeType?: string | null): boolean {
  if (!mimeType) return false
  return mimeType.startsWith("image/") || mimeType.startsWith("video/")
}

/**
 * Extensions worth accepting past the mime check. A browser hands back an empty
 * `type` for HEIC often enough that rejecting on mime alone turns away the exact
 * files an iPhone produces.
 */
const KNOWN_MEDIA_EXTENSIONS = /\.(?:hei[cf]|jpe?g|png|gif|webp|avif|tiff?|mp4|mov|m4v|webm)$/i

export function looksLikePhotoMedia(file: { type?: string; name: string }): boolean {
  return isPhotoMedia(file.type) || KNOWN_MEDIA_EXTENSIONS.test(file.name)
}

/** The `accept` attribute for a photo picker. */
export const PHOTO_UPLOAD_ACCEPT = "image/*,video/*,.heic,.heif"

/**
 * File categories whose images are paperwork, not a record of the work.
 *
 * A photographed receipt, a scanned contract and a snapshot of a permit card are
 * all `image/jpeg`, and none of them is a project photo. The category is the
 * uploading path's own statement about what the file is — every money path sets
 * it explicitly (`uploadCostPlusFile`, the payables inbox, and the payables
 * workspace all pass `financials`) — so it is a claim about intent rather than a
 * guess from the bytes.
 *
 * Deliberately short. `plans` and `submittals` are ambiguous — a photo of
 * delivered material filed under submittals is arguably site documentation — and
 * `rfis` and `safety` images are nearly always site conditions. Hiding a
 * superintendent's photo is a worse failure than showing a receipt, so anything
 * uncertain stays visible.
 *
 * This has a twin in SQL: the `project_photo_entries` view applies the same list
 * in its WHERE clause, and the two must move together.
 */
export const NON_PHOTO_FILE_CATEGORIES = ["financials", "contracts", "permits"] as const

export function isBusinessDocumentCategory(category?: string | null): boolean {
  if (!category) return false
  return (NON_PHOTO_FILE_CATEGORIES as readonly string[]).includes(category)
}
