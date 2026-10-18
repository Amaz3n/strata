import { z } from "zod"

const cents = z.number().int().min(0).max(100_000_000_00)
const reason = (minimum: string) => z.string().trim().min(10, minimum).max(1000)

/**
 * One move of a standing spec: its asking price (`kind: "price"`) or its own
 * incentive (`kind: "incentive"`, 0 removes it). The `expected…` figures are
 * what the caller saw, so a stale screen cannot move a price it never looked at.
 */
export const specPriceChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price"),
    lotId: z.string().uuid(),
    toCents: cents.min(1),
    expectedAskingPriceCents: cents,
    reason: reason("Say why the price is moving (at least 10 characters)."),
  }),
  z.object({
    kind: z.literal("incentive"),
    lotId: z.string().uuid(),
    toCents: cents,
    expectedAskingPriceCents: cents,
    expectedIncentiveCents: cents,
    expiresOn: z.string().date().nullable(),
    reason: reason("Say why the incentive is changing (at least 10 characters)."),
  }),
])
export type SpecPriceChangeInput = z.infer<typeof specPriceChangeSchema>

export const specPriceDecisionSchema = z.object({
  proposalId: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
})

export const specPriceWithdrawalSchema = z.object({ proposalId: z.string().uuid() })

/** The day a home was finished. Changing a recorded date needs a reason. */
export const specCompletionSchema = z.object({
  projectId: z.string().uuid(),
  completedOn: z.string().date(),
  reason: z.string().trim().max(1000).optional(),
})

export const SPEC_DISPOSITION_KINDS = ["bulk_sale", "investor_sale"] as const

export const specDispositionSchema = z.object({
  lotId: z.string().uuid(),
  kind: z.enum(SPEC_DISPOSITION_KINDS),
  counterpartyContactId: z.string().uuid(),
  counterpartyCompanyId: z.string().uuid().nullable(),
  priceCents: cents.min(1),
  reason: z.string().trim().min(10, "Say why this home is being sold off (at least 10 characters).").max(2000),
})

export const specDispositionDecisionSchema = z.object({
  dispositionId: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
})

/** The write-down a below-cost disposition needs, measured at the disposition price. */
export const specDispositionWriteDownSchema = z.object({
  dispositionId: z.string().uuid(),
  costToCompleteCents: cents,
  costToSellCents: cents,
  evidenceUrl: z.string().url().startsWith("https://"),
  assumptions: z.string().trim().min(10).max(4000),
})

/** Carrying out or cancelling a disposition names only the disposition; its home has one open agreement at most. */
export const specDispositionReferenceSchema = z.object({ dispositionId: z.string().uuid() })
