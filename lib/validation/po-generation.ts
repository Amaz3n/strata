import { z } from "zod"

export const poGenerationInputSchema = z.object({
  projectId: z.string().uuid(),
  mode: z.enum(["dry_run", "commit"]),
  asOfDate: z.string().date().optional(),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((input) => input.mode !== "commit" || input.expectedFingerprint !== undefined, {
  path: ["expectedFingerprint"],
  message: "Preview the purchase orders before generating them.",
})

/** Cents are stored as 32-bit integers, and a line multiplies this by its quantity. */
export const MAX_UNIT_COST_CENTS = 2_000_000_000

/** A free-issue or owner-supplied item is a real $0 line, but an unexplained one leaves no reason behind. */
export const ZERO_PRICE_NOTE_MIN_LENGTH = 10

export const poExceptionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agreement"), agreement_id: z.string().uuid() }),
  z.object({
    kind: z.literal("manual"), company_id: z.string().uuid(),
    unit_cost_cents: z.number().int().min(0).max(MAX_UNIT_COST_CENTS, "That unit price is more than the system can record."), note: z.string().trim().max(1000).optional(),
  }),
]).refine((input) => input.kind !== "manual" || input.unit_cost_cents > 0 || (input.note?.length ?? 0) >= ZERO_PRICE_NOTE_MIN_LENGTH, {
  path: ["note"],
  message: `A zero price needs a note of at least ${ZERO_PRICE_NOTE_MIN_LENGTH} characters saying why.`,
})

export type PoGenerationInput = z.infer<typeof poGenerationInputSchema>
export type PoExceptionResolution = z.infer<typeof poExceptionResolutionSchema>
