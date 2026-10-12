import { z } from "zod"

import { MIN_DECLINE_REASON_LENGTH } from "@/lib/plans/plan-change-impact"

export const createPlanChangeProposalSchema = z.object({
  planId: z.string().uuid(),
  toVersionId: z.string().uuid(),
  summary: z.string().trim().max(2000).optional().nullable(),
})

/** Ten million dollars either way: a plan change past this is a typo, not an amendment. */
const PRICE_DELTA_LIMIT_CENTS = 1_000_000_000

export const decidePlanChangeHomeSchema = z
  .object({
    proposalHomeId: z.string().uuid(),
    decision: z.enum(["adopt", "decline", "defer"]),
    reason: z.string().trim().max(2000).optional().nullable(),
    /** The amendment the buyer is asked to sign; only a sold home's adoption uses it. */
    priceDeltaCents: z.number().int().min(-PRICE_DELTA_LIMIT_CENTS).max(PRICE_DELTA_LIMIT_CENTS).optional(),
  })
  .refine((input) => input.decision !== "decline" || (input.reason ?? "").length >= MIN_DECLINE_REASON_LENGTH, {
    message: "Say why this home keeps the version it was sold at.",
    path: ["reason"],
  })

export type CreatePlanChangeProposalInput = z.input<typeof createPlanChangeProposalSchema>
export type DecidePlanChangeHomeInput = z.input<typeof decidePlanChangeHomeSchema>
