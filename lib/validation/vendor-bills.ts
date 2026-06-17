import { z } from "zod"
import { paymentMethodInputSchema } from "@/lib/validation/payments"

export const vendorBillStatusEnum = z.enum(["pending", "approved", "partial", "paid"]).default("pending")
const lienWaiverStatusSchema = z.preprocess((value) => {
  if (value === "pending") return "requested"
  return value
}, z.enum(["not_required", "requested", "received"]))

export const vendorBillStatusUpdateSchema = z.object({
  status: vendorBillStatusEnum,
  company_id: z.string().uuid("Invalid vendor").nullable().optional(),
  cost_code_id: z.string().uuid("Invalid cost code").nullable().optional(),
  bill_number: z.string().min(1).max(50).optional(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").nullable().optional(),
  actual_lines: z
    .array(
      z.object({
        cost_code_id: z.string().uuid("Invalid cost code").nullable().optional(),
        budget_line_id: z.string().uuid("Invalid budget line").nullable().optional(),
        description: z.string().min(1).max(500).optional(),
        amount_cents: z.number().int(),
        project_id: z.string().uuid("Invalid project").nullable().optional(),
        billable_to_customer: z.boolean().optional(),
        qbo_expense_account_id: z.string().optional(),
        qbo_expense_account_name: z.string().optional(),
        qbo_ap_account_id: z.string().optional(),
        qbo_ap_account_name: z.string().optional(),
        qbo_vendor_id: z.string().optional(),
        qbo_vendor_name: z.string().optional(),
      }),
    )
    .optional(),
  qbo_expense_account_id: z.string().optional(),
  qbo_expense_account_name: z.string().optional(),
  qbo_ap_account_id: z.string().optional(),
  qbo_ap_account_name: z.string().optional(),
  qbo_vendor_id: z.string().optional(),
  qbo_vendor_name: z.string().optional(),
  payment_method: paymentMethodInputSchema.optional(),
  payment_reference: z.string().max(200).optional(),
  payment_amount_cents: z.number().int().min(1).optional(),
  retainage_percent: z.number().min(0).max(25).optional(),
  lien_waiver_status: lienWaiverStatusSchema.optional(),
})

export type VendorBillStatusUpdate = z.infer<typeof vendorBillStatusUpdateSchema>

// Schema for creating a vendor bill from the sub portal
export const vendorBillCreateSchema = z.object({
  commitment_id: z.string().uuid("Invalid commitment").nullable().optional(),
  company_id: z.string().uuid("Invalid vendor").nullable().optional(),
  vendor_name: z.string().max(200).optional(),
  qbo_vendor_id: z.string().optional(),
  qbo_vendor_name: z.string().optional(),
  bill_number: z.string().min(1, "Invoice number is required").max(50),
  total_cents: z.number().int().positive("Amount must be greater than zero"),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  description: z.string().max(1000).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  file_id: z.string().uuid().nullable().optional(),
})

export type VendorBillCreate = z.infer<typeof vendorBillCreateSchema>
