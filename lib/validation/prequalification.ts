import { z } from "zod"

const optionalMoney = z.number().int().nonnegative().nullable().optional()

export const prequalificationSubmissionSchema = z.object({
  years_in_business: z.number().int().min(0).max(500).nullable().optional(),
  annual_revenue_cents: optionalMoney,
  largest_project_cents: optionalMoney,
  emr: z.number().min(0).max(10).nullable().optional(),
  bonding_single_cents: optionalMoney,
  bonding_aggregate_cents: optionalMoney,
  trades: z.array(z.string().trim().min(1).max(100)).max(49).default([]),
  references_data: z.array(z.record(z.unknown())).max(20).default([]),
  questionnaire: z.record(z.unknown()).default({}),
})

export const prequalificationReviewSchema = z.object({
  decision: z.enum(["approved", "approved_with_limits", "declined"]),
  expires_at: z.string().date().optional(),
  single_project_limit_cents: optionalMoney,
  aggregate_limit_cents: optionalMoney,
  review_notes: z.string().trim().max(5000).nullable().optional(),
}).superRefine((value, context) => {
  if (value.decision === "approved_with_limits" && value.single_project_limit_cents == null && value.aggregate_limit_cents == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one approval limit is required" })
  }
})
