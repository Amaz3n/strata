import { z } from "zod"

export const projectPhotoFiltersSchema = z.object({
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  source_type: z.string().trim().min(1).max(50).optional(),
  uploader_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
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

export type ProjectPhotoFilters = z.infer<typeof projectPhotoFiltersSchema>
export type ListProjectPhotosInput = z.infer<typeof listProjectPhotosSchema>
