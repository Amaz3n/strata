import { z } from "zod"

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
