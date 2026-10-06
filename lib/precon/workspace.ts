import { z } from "zod";

export const preconDesignStageSchema = z.enum([
  "feasibility",
  "concept",
  "design_development",
  "construction_documents",
]);
export const preconPricingPathSchema = z.enum([
  "budget_review",
  "direct_agreement",
]);

export const preconBriefSchema = z.object({
  pricing_revision: z.number().int().nonnegative().optional(),
  pricing_path: preconPricingPathSchema.default("budget_review"),
  direct_agreement_reason: z.string().trim().max(4000).default(""),
  target_budget_cents: z
    .number()
    .int()
    .nonnegative()
    .max(2_000_000_000)
    .nullable()
    .default(null),
  budget_basis: z.string().trim().max(4000).default(""),
  scope: z.string().trim().max(10000).default(""),
  governing_documents: z
    .array(
      z.object({
        id: z.string().uuid(),
        version_id: z.string().uuid().nullable(),
        name: z.string().min(1).max(500),
      }),
    )
    .max(50)
    .default([]),
  document_basis: z.string().trim().max(4000).default(""),
  design_stage: preconDesignStageSchema.default("feasibility"),
  target_start: z.string().date().nullable().default(null),
  estimate_due: z.string().date().nullable().default(null),
  client_decision_due: z.string().date().nullable().default(null),
  permit_target: z.string().date().nullable().default(null),
  estimating_owner_id: z.string().uuid().nullable().default(null),
  delivery_owner_id: z.string().uuid().nullable().default(null),
});
export type PreconBrief = z.infer<typeof preconBriefSchema>;
export const EMPTY_PRECON_BRIEF: PreconBrief = {
  pricing_path: "budget_review",
  direct_agreement_reason: "",
  target_budget_cents: null,
  budget_basis: "",
  scope: "",
  governing_documents: [],
  document_basis: "",
  design_stage: "feasibility",
  target_start: null,
  estimate_due: null,
  client_decision_due: null,
  permit_target: null,
  estimating_owner_id: null,
  delivery_owner_id: null,
};

export const DECISION_KINDS = [
  "scope",
  "client_decision",
  "risk",
  "procurement",
  "readiness",
] as const;
export const preconDecisionSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Describe the decision or open issue")
      .max(200),
    kind: z.enum(DECISION_KINDS),
    detail: z.string().trim().max(6000).default(""),
    owner_user_id: z.string().uuid().nullable(),
    due_date: z.string().date().nullable(),
    cost_impact_cents: z
      .number()
      .int()
      .min(-2_000_000_000)
      .max(2_000_000_000)
      .nullable(),
    blocks_agreement: z.boolean().default(false),
    blocks_start: z.boolean().default(false),
    status: z.enum(["open", "resolved", "waived"]).default("open"),
    resolution: z.string().trim().max(6000).default(""),
  })
  .superRefine((value, context) => {
    if (value.status !== "open" && value.resolution.length < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "Record the decision or reason for accepting this exception",
      });
    }
    if (
      (value.blocks_agreement || value.blocks_start) &&
      !value.owner_user_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["owner_user_id"],
        message: "Assign an owner for a blocking item",
      });
    }
  });
export type PreconDecisionInput = z.infer<typeof preconDecisionSchema>;
export type PreconDecision = PreconDecisionInput & {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  resolved_by: string | null;
};
export type PreconWorkspaceRecord = {
  pricing?: import("./pricing-worksheet").PricingWorksheet | null;
  brief: PreconBrief;
  version: number;
  decisions: PreconDecision[];
  truncated: boolean;
  available: boolean;
};
