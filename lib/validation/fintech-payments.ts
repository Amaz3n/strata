import { z } from "zod"

export const paymentApprovalModeSchema = z.enum(["sole", "dual"])

export const updatePaymentRailPolicySchema = z.object({
  enabled: z.boolean().optional(),
  approval_mode: paymentApprovalModeSchema.optional(),
  /** Explicit owner-operated exception; false preserves maker-checker separation. */
  requester_may_approve: z.boolean().optional(),
  control_change_cooling_hours: z.number().int().min(24).max(168).optional(),
  per_payment_limit_cents: z.number().int().positive().nullable().optional(),
  per_run_limit_cents: z.number().int().positive().nullable().optional(),
  daily_limit_cents: z.number().int().positive().nullable().optional(),
  max_inflight_cents: z.number().int().positive().nullable().optional(),
  return_loss_ceiling_cents: z.number().int().positive().nullable().optional(),
  payout_hold_hours: z.number().int().min(48).max(720).optional(),
  new_vendor_hold_hours: z.number().int().min(24).max(720).optional(),
}).superRefine((value, context) => {
  if (value.requester_may_approve && value.approval_mode === "dual") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requester_may_approve"],
      message: "Self-approval is only available when one approval is required",
    })
  }
  // Every present pair, not just adjacent ones. The chain only ever compared
  // neighbours, so a patch carrying per-payment and daily but not per-run — the
  // shape a partial edit produces — was checked against nothing at all. Presence
  // is `!= null`, never truthiness: an explicit null clears a limit and has
  // nothing to compare, which is not the same question as "is it set".
  //
  // A patch cannot see the limits it is not changing, so a value that inverts an
  // existing stored limit still gets past this. Merging the patch onto the row
  // and re-checking the whole chain is the service's job — `updatePaymentRailPolicy`
  // is the only place that holds both halves.
  const ascendingLimits = [
    { path: "per_payment_limit_cents", label: "Per-payment limit", value: value.per_payment_limit_cents },
    { path: "per_run_limit_cents", label: "Run limit", value: value.per_run_limit_cents },
    { path: "daily_limit_cents", label: "Daily limit", value: value.daily_limit_cents },
    { path: "max_inflight_cents", label: "In-flight exposure limit", value: value.max_inflight_cents },
  ] as const
  for (let lower = 0; lower < ascendingLimits.length; lower += 1) {
    for (let upper = lower + 1; upper < ascendingLimits.length; upper += 1) {
      const floor = ascendingLimits[lower]
      const ceiling = ascendingLimits[upper]
      if (floor.value == null || ceiling.value == null || ceiling.value >= floor.value) continue
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [ceiling.path],
        message: `${ceiling.label} must be at least the ${floor.label.toLowerCase()}`,
      })
    }
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
  // Exactly one verified ACH destination per payable is the rail, and this is
  // the outermost of the three layers that say so: the create RPC rejects any
  // other length, and the table carries a `method = 'ach'` check, a
  // `payee_kind = 'primary_vendor'` check and a unique index on `run_item_id`.
  // Joint and external checks belong to the manual-payment workflow until they
  // have their own verification and execution path, so nothing here splits a
  // payment and the sum-across-payees arithmetic that implied otherwise is gone.
  payees: z.array(z.object({
    payee_kind: z.literal("primary_vendor"),
    method: z.literal("ach"),
    payee_name: z.string().trim().min(1).max(200),
    amount_cents: z.number().int().positive(),
  })).length(1),
}).superRefine((item, context) => {
  if (item.payees[0] && item.payees[0].amount_cents !== item.amount_cents) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payees"], message: "The payee amount must equal the vendor payment amount" })
  }
})

export const createPaymentRunSchema = z.object({
  funding_source_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(8).max(200),
  items: z.array(paymentRunItemSchema).min(1).max(200),
  /** Browser workbenches continue past bad rows; API/mobile callers keep atomic refusal by default. */
  mode: z.enum(["all_or_nothing", "skip_failures"]).default("all_or_nothing"),
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

/**
 * A same-origin path, and nothing else.
 *
 * `startsWith("/")` accepted `//evil.com`, which `new URL("//evil.com", base)`
 * resolves as protocol-relative — off-origin — and which was then handed to
 * Stripe as the onboarding `return_url`/`refresh_url`. A payout-verification
 * flow must not be able to exit onto an attacker's domain. Backslashes are
 * rejected for the same reason: browsers normalise `/\evil.com` to `//evil.com`.
 */
export const portalReturnPathSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/(?!\/)[^\\\s]*$/, "Return path must be a same-origin path beginning with a single /")

/**
 * `return_path` is required, deliberately without a default.
 *
 * It defaulted to `/access`, and Stripe sends the vendor back to it when the
 * onboarding link expires — `/access` is a workspace router that reads neither
 * of the parameters the return carries, so the default dead-ended the vendor on
 * a list of builders with no way back into verification. The caller knows the
 * page that started the flow; nothing here can guess it.
 */
export const startVendorPayoutSetupSchema = z.object({
  ...vendorClaimFields,
  return_path: portalReturnPathSchema,
}).superRefine(requireEntityOrLegalName)

export type UpdatePaymentRailPolicyInput = z.infer<typeof updatePaymentRailPolicySchema>
export type CreatePaymentRunInput = z.input<typeof createPaymentRunSchema>
export type SubmitPaymentRunInput = z.infer<typeof submitPaymentRunSchema>
export type DecidePaymentRunInput = z.infer<typeof decidePaymentRunSchema>
export type VendorClaimInput = z.infer<typeof vendorClaimSchema>
export type StartVendorPayoutSetupInput = z.infer<typeof startVendorPayoutSetupSchema>
