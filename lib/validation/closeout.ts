import { z } from "zod"

export const closeoutItemStatusSchema = z.enum(["missing", "in_progress", "complete"]).default("missing")

export const closeoutItemInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  closeout_package_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1, "Title is required").max(200),
  status: closeoutItemStatusSchema.optional(),
  file_id: z.string().uuid().optional().nullable(),
})

export const closeoutItemUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: closeoutItemStatusSchema.optional(),
  file_id: z.string().uuid().optional().nullable(),
})

export type CloseoutItemInput = z.infer<typeof closeoutItemInputSchema>
export type CloseoutItemUpdate = z.infer<typeof closeoutItemUpdateSchema>
