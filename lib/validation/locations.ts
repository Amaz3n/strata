import { z } from "zod"

export const locationNameSchema = z.string().trim().min(1).max(200).refine(
  (name) => !name.includes(">"),
  "Location names cannot contain >",
)

export const createLocationSchema = z.object({
  project_id: z.string().uuid(),
  parent_id: z.string().uuid().optional().nullable(),
  name: locationNameSchema,
  sort_order: z.number().int().optional(),
})

export const updateLocationSchema = z.object({ name: locationNameSchema })

export const setLocationActiveSchema = z.object({ is_active: z.boolean() })

export const bulkCreateLocationsSchema = z.object({
  project_id: z.string().uuid(),
  text: z.string().trim().min(1).max(20_000),
})

export const locationSelectionSchema = z.object({
  location_id: z.string().uuid().optional().nullable(),
  location: z.string().trim().max(1000).optional().nullable(),
})

