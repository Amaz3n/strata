import { z } from "zod"
import { paymentMethodInputSchema } from "@/lib/validation/payments"

export const vendorBillStatusEnum = z.enum(["pending", "approved", "partial", "paid"]).default("pending")

export const vendorBillStatusUpdateSchema = z.object({
  status: vendorBillStatusEnum,
  payment_method: paymentMethodInputSchema.optional(),
  payment_reference: z.string().max(200).optional(),
  payment_amount_cents: z.number().int().min(1).optional(),
  retainage_percent: z.number().min(0).max(25).optional(),
  lien_waiver_status: z.enum(["not_required", "requested", "received"]).optional(),
})

export type VendorBillStatusUpdate = z.infer<typeof vendorBillStatusUpdateSchema>

// Schema for creating a vendor bill from the sub portal
export const vendorBillCreateSchema = z.object({
  commitment_id: z.string().uuid("Invalid commitment"),
  bill_number: z.string().min(1, "Invoice number is required").max(50),
  total_cents: z.number().int().positive("Amount must be greater than zero"),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  description: z.string().max(1000).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  file_id: z.string().uuid().optional(),
})

export type VendorBillCreate = z.infer<typeof vendorBillCreateSchema>
