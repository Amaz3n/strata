import { z } from "zod"

export const poGenerationInputSchema = z.object({
  projectId: z.string().uuid(),
  mode: z.enum(["dry_run", "commit"]),
  asOfDate: z.string().date().optional(),
})

export const poExceptionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agreement"), agreement_id: z.string().uuid() }),
  z.object({
    kind: z.literal("manual"), company_id: z.string().uuid(),
    unit_cost_cents: z.number().int().min(0), note: z.string().trim().max(1000).optional(),
  }),
])

export type PoGenerationInput = z.infer<typeof poGenerationInputSchema>
export type PoExceptionResolution = z.infer<typeof poExceptionResolutionSchema>
