import { z } from "zod"

export const paymentApprovalModeSchema = z.enum(["sole", "dual"])

export const updatePaymentRailPolicySchema = z.object({
  enabled: z.boolean().optional(),
  approval_mode: paymentApprovalModeSchema.optional(),
  control_change_cooling_hours: z.number().int().min(24).max(168).optional(),
  per_payment_limit_cents: z.number().int().positive().nullable().optional(),
  per_run_limit_cents: z.number().int().positive().nullable().optional(),
  daily_limit_cents: z.number().int().positive().nullable().optional(),
}).superRefine((value, context) => {
  if (value.per_payment_limit_cents && value.per_run_limit_cents && value.per_run_limit_cents < value.per_payment_limit_cents) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["per_run_limit_cents"], message: "Run limit must be at least the per-payment limit" })
  }
})

export const setPaymentRunApproversSchema = z.object({
  approvers: z
    .array(
      z.object({
        user_id: z.string().uuid(),
        approval_limit_cents: z.number().int().positive().nullable().optional(),
        /** Restricts this entry to one division. Null or absent is org-wide. */
        division_id: z.string().uuid().nullable().optional(),
      }),
    )
    .max(50)
    .superRefine((approvers, context) => {
      // One entry per person per scope: the same person may hold a low org-wide
      // ceiling and a higher one inside their own division.
      const scopes = new Set(approvers.map((approver) => `${approver.user_id}:${approver.division_id ?? "org"}`))
      if (scopes.size !== approvers.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Each approver can only be listed once per division" })
      }
    }),
})

export type SetPaymentRunApproversInput = z.infer<typeof setPaymentRunApproversSchema>

export const paymentRunItemSchema = z.object({
  bill_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  retainage_held_cents: z.number().int().min(0).default(0),
  payees: z.array(z.object({
    payee_kind: z.enum(["primary_vendor", "joint_payee"]),
    method: z.enum(["ach", "external_check"]),
    recipient_account_id: z.string().uuid().nullable().optional(),
    payee_name: z.string().trim().min(1).max(200),
    amount_cents: z.number().int().positive(),
  })).min(1),
}).superRefine((item, context) => {
  const payeeTotal = item.payees.reduce((sum, payee) => sum + payee.amount_cents, 0)
  if (payeeTotal !== item.amount_cents) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payees"], message: "Payee amounts must equal the vendor payment amount" })
  }
  item.payees.forEach((payee, index) => {
    // Primary-vendor destinations are always resolved from the trusted vendor
    // relationship on the server. A client-supplied UUID must never be the
    // authority for where money is sent. Joint payees remain explicit because
    // they have a separately verified destination.
    if (payee.method === "ach" && payee.payee_kind === "joint_payee" && !payee.recipient_account_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["payees", index, "recipient_account_id"], message: "Joint ACH payees require a verified recipient account" })
    }
  })
})

export const createPaymentRunSchema = z.object({
  funding_source_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(8).max(200),
  items: z.array(paymentRunItemSchema).min(1).max(200),
})

/**
 * The preparer names the business date they want the run released on. Omitting it
 * means "release as soon as it is approved", which is how every run behaved before
 * scheduling existed. The date is validated again in the database against
 * `current_date`, because a client clock is not a control.
 */
export const submitPaymentRunSchema = z.object({
  run_id: z.string().uuid(),
  scheduled_for: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
})

export const decidePaymentRunSchema = z.object({
  run_id: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(8).max(1000).optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, context) => {
  if (value.decision === "rejected" && !value.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Rejection reason is required" })
  }
})

/**
 * The vendor either points at a company they already administer or names a new
 * legal entity. There is deliberately no password field: the portal session has
 * already proven who this human is, and a second credential prompt on the same
 * page only ever asked for a copy of the one they just used.
 */
const vendorClaimFields = {
  portal_token: z.string().trim().min(1),
  vendor_entity_id: z.string().uuid().optional(),
  legal_name: z.string().trim().min(1).max(200).optional(),
  dba_name: z.string().trim().max(200).optional(),
}

const requireEntityOrLegalName = (
  value: { vendor_entity_id?: string; legal_name?: string },
  context: z.RefinementCtx,
) => {
  if (!value.vendor_entity_id && !value.legal_name) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["legal_name"], message: "Choose or create a vendor entity" })
  }
}

export const vendorClaimSchema = z.object(vendorClaimFields).superRefine(requireEntityOrLegalName)

export const startVendorPayoutSetupSchema = z.object({
  ...vendorClaimFields,
  return_path: z.string().startsWith("/").max(500).default("/access"),
}).superRefine(requireEntityOrLegalName)

export type UpdatePaymentRailPolicyInput = z.infer<typeof updatePaymentRailPolicySchema>
export type CreatePaymentRunInput = z.infer<typeof createPaymentRunSchema>
export type SubmitPaymentRunInput = z.infer<typeof submitPaymentRunSchema>
export type DecidePaymentRunInput = z.infer<typeof decidePaymentRunSchema>
export type VendorClaimInput = z.infer<typeof vendorClaimSchema>
export type StartVendorPayoutSetupInput = z.infer<typeof startVendorPayoutSetupSchema>
