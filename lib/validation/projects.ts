import { z } from "zod"

export const projectInputSchema = z.object({
  name: z.string().min(2, "Name is required"),
  status: z.enum(["planning", "bidding", "active", "on_hold", "completed", "cancelled"]).default("active"),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  address: z.string().optional(),
  total_value: z.number().min(0, "Total value must be positive").optional(),
  property_type: z.enum(["residential", "commercial"]).optional(),
  project_type: z.enum(["new_construction", "remodel", "addition", "renovation", "repair"]).optional(),
  description: z.string().optional(),
  location: z
    .object({
      formatted: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
})

export const projectUpdateSchema = projectInputSchema.partial()

export type ProjectInput = z.infer<typeof projectInputSchema>
