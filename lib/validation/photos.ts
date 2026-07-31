import { z } from "zod"

export const projectPhotoFiltersSchema = z.object({
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  source_type: z.string().trim().min(1).max(50).optional(),
  uploader_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  album_id: z.string().uuid().optional(),
  visibility: z.enum(["internal", "client"]).optional(),
  search: z.string().trim().min(2).max(120).optional(),
})

export const listProjectPhotosSchema = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().max(300).nullable().optional(),
  limit: z.number().int().min(1).max(48).default(30),
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

export const photoMetadataInputSchema = z.object({
  project_id: z.string().uuid(),
  file_id: z.string().uuid(),
  album_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  trade_company_id: z.string().uuid().nullable().optional(),
  taken_at: z.string().datetime().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  visibility: z.enum(["internal", "client"]).optional(),
})

export type ProjectPhotoFilters = z.infer<typeof projectPhotoFiltersSchema>
export type ListProjectPhotosInput = z.infer<typeof listProjectPhotosSchema>
