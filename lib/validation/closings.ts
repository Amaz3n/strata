import { z } from "zod"

import { SETTLEMENT_ADJUSTMENT_KINDS } from "@/lib/financials/purchase-agreement-pricing"

export const upsertClosingAdjustmentSchema = z.object({
  closingId: z.string().uuid(),
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(200),
  kind: z.enum(SETTLEMENT_ADJUSTMENT_KINDS),
  // Buyer's sign: positive adds to what the buyer owes, negative credits them.
  amountCents: z.number().int().refine((value) => value !== 0, "A settlement adjustment cannot be zero"),
})

export const scheduleClosingSchema = z.object({
  closingId: z.string().uuid(),
  scheduledDate: z.string().date(),
})

export const updateClosingChecklistItemSchema = z.object({
  itemId: z.string().uuid(),
  status: z.enum(["open", "complete", "waived"]),
  fileId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

export const settleClosingSchema = z.object({
  closingId: z.string().uuid(),
  actualDate: z.string().date(),
  paymentMethod: z.enum(["wire", "check"]).default("wire"),
  paymentReference: z.string().min(1).max(200),
})
