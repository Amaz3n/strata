import { z } from "zod"

/** `album_id`/`location_id` accept this in place of a uuid to mean "records with
 *  nothing assigned", which is the filter someone curating actually wants. */
export const UNASSIGNED = "none"

const uuidOrUnassigned = z.union([z.string().uuid(), z.literal(UNASSIGNED)])

export const projectPhotoFiltersSchema = z.object({
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  source_type: z.string().trim().min(1).max(50).optional(),
  uploader_id: z.string().uuid().optional(),
  location_id: uuidOrUnassigned.optional(),
  album_id: uuidOrUnassigned.optional(),
  trade_company_id: z.string().uuid().optional(),
  visibility: z.enum(["internal", "client"]).optional(),
  media_kind: z.enum(["image", "video"]).optional(),
  /** Only photos carrying a GPS fix — what the map view lists. */
  geotagged: z.boolean().optional(),
  search: z.string().trim().min(2).max(120).optional(),
})

export const listProjectPhotosSchema = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().max(300).nullable().optional(),
  limit: z.number().int().min(1).max(96).default(30),
  filters: projectPhotoFiltersSchema.default({}),
})

export const ensurePhotoDailyLogSchema = z.object({
  projectId: z.string().uuid(),
  localDate: z.string().date(),
})

export const photoAlbumInputSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
})

export const renamePhotoAlbumSchema = z.object({
  project_id: z.string().uuid(),
  album_id: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
})

export const deletePhotoAlbumSchema = z.object({
  project_id: z.string().uuid(),
  album_id: z.string().uuid(),
})

/** The curated fields. `undefined` leaves a field alone, `null` clears it — the
 *  difference is what lets one editor patch a single field without wiping the
 *  rest of the record. */
const photoMetadataPatch = {
  album_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  trade_company_id: z.string().uuid().nullable().optional(),
  taken_at: z.string().datetime().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  visibility: z.enum(["internal", "client"]).optional(),
}

export const photoMetadataInputSchema = z.object({
  project_id: z.string().uuid(),
  file_id: z.string().uuid(),
  ...photoMetadataPatch,
})

/** One trip for a whole selection. Capped because the bulk bar has to tell the
 *  user what it did, and "some of them" is not a report. */
export const bulkPhotoMetadataSchema = z.object({
  project_id: z.string().uuid(),
  file_ids: z.array(z.string().uuid()).min(1).max(200),
  album_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  trade_company_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(["internal", "client"]).optional(),
})

/** What the browser read off the file before uploading it. The server trusts the
 *  instant only because the alternative — EXIF wall-clock with no zone — is not
 *  an instant at all (lib/media/exif.ts explains the choice). */
export const photoCaptureMetadataSchema = z.object({
  taken_at: z.string().datetime().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
})

export type ProjectPhotoFilters = z.infer<typeof projectPhotoFiltersSchema>
export type ListProjectPhotosInput = z.infer<typeof listProjectPhotosSchema>
export type PhotoMetadataInput = z.infer<typeof photoMetadataInputSchema>
export type BulkPhotoMetadataInput = z.infer<typeof bulkPhotoMetadataSchema>
export type PhotoAlbumInput = z.infer<typeof photoAlbumInputSchema>
export type RenamePhotoAlbumInput = z.infer<typeof renamePhotoAlbumSchema>
export type DeletePhotoAlbumInput = z.infer<typeof deletePhotoAlbumSchema>
export type PhotoCaptureMetadata = z.infer<typeof photoCaptureMetadataSchema>
