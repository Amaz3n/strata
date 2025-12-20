import { z } from "zod"

export const projectInputSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  status: z.enum(["planning", "bidding", "active", "on_hold", "completed", "cancelled"]).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  address: z.string().optional(),
  location: z.record(z.unknown()).optional(),
  client_id: z.string().uuid().optional().nullable(),
  description: z.string().optional(),
  property_type: z.enum(["residential", "commercial"]).optional(),
  project_type: z.enum(["new_construction", "remodel", "addition", "renovation", "repair"]).optional(),
  total_value: z.number().optional(),
})

export const projectUpdateSchema = projectInputSchema.partial()

export type ProjectInput = z.infer<typeof projectInputSchema>
