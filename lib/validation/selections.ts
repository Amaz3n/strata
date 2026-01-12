import { z } from "zod"

export const selectionStatusSchema = z.enum(["pending", "selected", "confirmed", "ordered", "received"])

export const selectionInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  category_id: z.string().uuid("Category is required"),
  status: selectionStatusSchema.default("pending"),
  due_date: z.string().optional(),
  notes: z
    .string()
    .max(1000, "Notes too long")
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : undefined)),
})

export type SelectionInput = z.infer<typeof selectionInputSchema>








