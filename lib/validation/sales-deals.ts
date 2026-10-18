import { z } from "zod"
import { HOME_PRICE_ADJUSTMENT_KINDS } from "@/lib/financials/purchase-agreement-pricing"

const cents = z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)]).pipe(z.number().int().safe())
const pricedItem = z.object({ optionId: z.string().optional(), packageId: z.string().optional(), category: z.string().nullable().optional(), label: z.string(), priceCents: cents, source: z.string() })
const pricing = z.object({
  basePriceCents: cents, lotPremiumCents: cents, structuralOptions: z.array(pricedItem), designSelections: z.array(pricedItem),
  incentives: z.array(z.object({ incentiveId: z.string(), name: z.string(), incentiveType: z.enum(["fixed_amount", "percent_of_base"]), appliesTo: z.enum(["price", "design_credit"]), amountCents: cents.nullable().optional(), percent: z.number().finite().nullable().optional(), valueCents: cents })),
  // Absent on agreements priced before a home's own lines were separated from incentives.
  homeAdjustments: z.array(z.object({ kind: z.enum(HOME_PRICE_ADJUSTMENT_KINDS), sourceId: z.string(), label: z.string(), amountCents: cents })).optional(),
  structuralOptionsCents: cents, designSelectionsCents: cents, incentivesCents: cents, homeAdjustmentsCents: cents.optional(), totalCents: cents,
})
export const salesAgreementDetailSchema = z.object({
  project_id: z.string().uuid(), contract_type: z.literal("purchase_agreement"),
  snapshot: z.object({ purchase_agreement: z.object({ pricing: pricing.optional() }).optional() }),
})
export const salesReservationDetailSchema = z.object({
  id: z.string().uuid(), lot_id: z.string().uuid(), community_id: z.string().uuid(), prospect_id: z.string().uuid().nullable(), contract_id: z.string().uuid().nullable(),
  status: z.string(), expires_at: z.string().nullable(), asking_price_cents: cents.nullable(), deposit_required_cents: cents.refine(value => value >= 0), deposit_invoice_id: z.string().uuid().nullable(), notes: z.string().nullable(),
})
