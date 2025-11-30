import { z } from "zod"

export const projectInputSchema = z.object({
  name: z.string().min(2, "Name is required"),
  status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).default("active"),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  address: z.string().optional(),
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
