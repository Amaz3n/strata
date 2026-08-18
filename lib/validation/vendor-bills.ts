import { z } from "zod"
import { paymentMethodInputSchema } from "@/lib/validation/payments"

/**
 * Required, deliberately. This enum used to default to `pending`, and the
 * update service always writes `status`, so any caller that omitted it silently
 * UNAPPROVED the payable. A missing status is a caller bug; it must fail
 * validation rather than quietly revoke an approval.
 */
export const vendorBillStatusEnum = z.enum(["pending", "approved", "partial", "paid", "rejected"])
const lienWaiverStatusSchema = z.preprocess((value) => {
  if (value === "pending") return "requested"
  // Legacy vocabulary: older desk/hold code wrote "signed" for a waiver in
  // hand. The schema's word for that state is "received"; normalize at the
  // boundary so no reader needs a "signed" special-case.
  if (value === "signed") return "received"
  return value
}, z.enum(["not_required", "requested", "received"]))

export const vendorBillStatusUpdateSchema = z.object({
  status: vendorBillStatusEnum,
  expected_updated_at: z.string().min(1).optional(),
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
        accounting_dimensions: z.record(z.string(), z.object({ id: z.string().min(1), name: z.string().max(300) })).optional(),
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
  /** A real identifier, checked for duplicates — not a note in the reference field. */
  check_number: z.string().trim().min(1).max(40).optional(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid payment date").optional(),
  payment_amount_cents: z.number().int().min(1).optional(),
  /** Stable across retries so recording a manual payment is exactly-once. */
  payment_idempotency_key: z.string().trim().min(8).max(200).optional(),
  retainage_percent: z.number().min(0).max(25).optional(),
  /**
   * "2/10 net 30" as two numbers. The payment-run builder already prices these
   * and surfaces the saving; until now nothing could record the terms, so the
   * discount hint could never fire.
   */
  early_pay_discount_percent: z.number().min(0).max(25).nullable().optional(),
  early_pay_discount_days: z.number().int().min(1).max(180).nullable().optional(),
  lien_waiver_status: lienWaiverStatusSchema.optional(),
  /**
   * Payment preferences. These were captured once at creation and then frozen,
   * which made `payment_channel` in particular a trap: the payment-run preparer
   * refuses an `external` payable and tells the user to "change its payment
   * method on the payable", and nothing could. They are ordinary editable
   * fields on a payable that has not been paid yet.
   */
  payment_channel: z.enum(["arc", "external"]).optional(),
  preferred_payment_method: z.enum(["ach", "check", "wire", "card", "other"]).nullable().optional(),
  payment_memo: z.string().trim().max(140).nullable().optional(),
  preferred_funding_source_id: z.string().uuid("Invalid funding account").nullable().optional(),
  payment_schedule: z.enum(["on_approval", "scheduled"]).optional(),
  scheduled_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid payment date").nullable().optional(),
  preferred_approver_ids: z.array(z.string().uuid("Invalid approver")).max(20).optional(),
  /**
   * Required to reject. The vendor is shown this verbatim, so it has to say
   * something — "no" with no reason is how an invoice gets resubmitted unchanged.
   */
  rejection_reason: z.string().trim().min(8, "Tell the vendor why in at least a few words").max(1000).optional(),
})

export type VendorBillStatusUpdate = z.infer<typeof vendorBillStatusUpdateSchema>

// Schema for creating a vendor bill from the sub portal
export const vendorBillCreateSchema = z.object({
  creation_state: z.enum(["draft", "ready"]).default("ready"),
  commitment_id: z.string().uuid("Invalid commitment").nullable().optional(),
  company_id: z.string().uuid("Invalid vendor").nullable().optional(),
  vendor_name: z.string().max(200).optional(),
  qbo_vendor_id: z.string().optional(),
  qbo_vendor_name: z.string().optional(),
  bill_number: z.string().min(1, "Invoice number is required").max(50),
  total_cents: z.number().int().positive("Amount must be greater than zero"),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  tax_jurisdiction_id: z.string().uuid().nullable().optional(),
  tax_included_cents: z.number().int().nonnegative().optional(),
  use_tax_accrued_cents: z.number().int().nonnegative().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  description: z.string().max(1000).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  file_id: z.string().uuid().nullable().optional(),
  actual_lines: vendorBillStatusUpdateSchema.shape.actual_lines,
  retainage_percent: z.number().min(0).max(25).optional(),
  early_pay_discount_percent: z.number().min(0).max(25).nullable().optional(),
  early_pay_discount_days: z.number().int().min(1).max(180).nullable().optional(),
  lien_waiver_status: lienWaiverStatusSchema.optional(),
  preferred_payment_method: z.enum(["ach", "check", "wire", "card", "other"]).nullable().optional(),
  /** Short remittance note shown in Arc and forwarded to the payment provider. */
  payment_memo: z.string().trim().max(140).nullable().optional(),
  /**
   * Who moves the money. `arc` means this payable can join a payment run and be
   * disbursed on the rail; `external` means the builder pays it themselves and
   * records the payment afterwards. It is a real gate, not a label — an
   * `external` payable is refused by the payment-run preparer.
   */
  payment_channel: z.enum(["arc", "external"]).optional(),
  /** Payment-run preferences captured while the invoice is being reviewed. */
  preferred_funding_source_id: z.string().uuid("Invalid funding account").nullable().optional(),
  payment_schedule: z.enum(["on_approval", "scheduled"]).optional(),
  scheduled_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid payment date").nullable().optional(),
  preferred_approver_ids: z.array(z.string().uuid("Invalid approver")).max(20).optional(),
  coding_source: z.enum(["manual", "learned", "ai"]).optional(),
  coding_confidence: z.number().min(0).max(1).optional(),
})

export type VendorBillCreate = z.input<typeof vendorBillCreateSchema>

/**
 * The subset of `vendorBillCreateSchema` an inbound emailed invoice must
 * satisfy to enter the approval queue as a ready payable: a real invoice
 * number, a positive amount, a valid date. Email ingest validates its
 * extraction output through these same rules instead of inserting raw rows —
 * anything that fails lands as a draft flagged for human completion, never as
 * an approvable zero-amount, unnumbered bill invisible to duplicate detection.
 */
export const emailIngestBillCoreSchema = vendorBillCreateSchema.pick({
  bill_number: true,
  total_cents: true,
  bill_date: true,
})
