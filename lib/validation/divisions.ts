import { z } from "zod"

export const divisionInputSchema = z.object({
  name: z.string().trim().min(1, "Division name is required").max(120),
  code: z.string().trim().max(8).transform((value) => value.toUpperCase()).optional().nullable(),
  region: z.string().trim().max(120).optional().nullable(),
  settings: z.record(z.unknown()).optional(),
})

export const divisionUpdateSchema = divisionInputSchema.partial()

export type DivisionInput = z.infer<typeof divisionInputSchema>
