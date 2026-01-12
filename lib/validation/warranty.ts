import { z } from "zod"

export const warrantyStatusSchema = z.enum(["open", "in_progress", "resolved", "closed"]).default("open")
export const warrantyPrioritySchema = z.enum(["low", "normal", "high", "urgent"]).default("normal")

export const warrantyRequestInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional().nullable(),
  priority: warrantyPrioritySchema.optional(),
  status: warrantyStatusSchema.optional(),
})

export const warrantyRequestUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  priority: warrantyPrioritySchema.optional(),
  status: warrantyStatusSchema.optional(),
})

export type WarrantyRequestInput = z.infer<typeof warrantyRequestInputSchema>
export type WarrantyRequestUpdate = z.infer<typeof warrantyRequestUpdateSchema>
