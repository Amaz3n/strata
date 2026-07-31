import { z } from "zod"

export const paymentHoldKindSchema = z.enum([
  "insurance_current",
  "waiver_signed",
  "compliance_docs_approved",
  "retainage_rules_met",
  "funding_received",
])

export const paymentHoldLevelSchema = z.enum(["block", "warn"])

export const paymentHoldPolicySchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  conditions: z.record(paymentHoldKindSchema, paymentHoldLevelSchema).default({}),
  waiver_auto_chase: z.boolean().default(true),
})

export const paymentHoldOverrideSchema = z.object({
  bill_id: z.string().uuid(),
  hold_kind: paymentHoldKindSchema,
  reason: z.string().trim().min(8).max(2000),
})

export type PaymentHoldKind = z.infer<typeof paymentHoldKindSchema>
export type PaymentHoldLevel = z.infer<typeof paymentHoldLevelSchema>
export type PaymentHoldOverrideInput = z.infer<typeof paymentHoldOverrideSchema>
