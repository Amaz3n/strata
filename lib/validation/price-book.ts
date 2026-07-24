import { z } from "zod"
import { COST_TYPES } from "@/lib/cost-types"

const optionalUuid = z.string().uuid().nullable().optional()

export const priceAgreementInputSchema = z.object({
  company_id: z.string().uuid(),
  cost_code_id: z.string().uuid(),
  cost_type: z.enum(COST_TYPES).nullable().optional(),
  division_id: optionalUuid,
  community_id: optionalUuid,
  house_plan_id: optionalUuid,
  house_plan_version_id: optionalUuid,
  pricing_kind: z.enum(["unit", "lump_sum"]),
  uom: z.string().trim().min(1).max(30).nullable().optional(),
  unit_cost_cents: z.number().int().min(0).nullable().optional(),
  lump_sum_cents: z.number().int().min(0).nullable().optional(),
  scope_of_work: z.string().trim().max(10_000).nullable().optional(),
  effective_from: z.string().date(),
  effective_to: z.string().date().nullable().optional(),
  status: z.enum(["draft", "active"]).default("active"),
  notes: z.string().trim().max(5_000).nullable().optional(),
  source: z.enum(["manual", "import"]).default("manual"),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  if (value.house_plan_version_id && !value.house_plan_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["house_plan_id"], message: "A version requires a house plan." })
  }
  if (value.effective_to && value.effective_to < value.effective_from) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effective_to"], message: "End date must follow start date." })
  }
  if (value.pricing_kind === "unit") {
    if (!value.uom || value.unit_cost_cents == null || value.lump_sum_cents != null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["unit_cost_cents"], message: "Unit pricing requires UOM and unit cost only." })
    }
  } else if (value.lump_sum_cents == null || value.unit_cost_cents != null || !value.house_plan_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lump_sum_cents"], message: "Lump-sum pricing requires a plan and lump sum only." })
  }
})

export const repriceAgreementSchema = z.object({
  effective_from: z.string().date(),
  unit_cost_cents: z.number().int().min(0).nullable().optional(),
  lump_sum_cents: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(5_000).nullable().optional(),
})

export const priceAgreementFiltersSchema = z.object({
  companyId: optionalUuid,
  costCodeId: optionalUuid,
  communityId: optionalUuid,
  divisionId: optionalUuid,
  housePlanId: optionalUuid,
  status: z.enum(["draft", "active", "expired", "superseded", "void"]).optional(),
  expiringWithinDays: z.number().int().min(1).max(365).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
})

export type PriceAgreementInput = z.infer<typeof priceAgreementInputSchema>
export type RepriceAgreementInput = z.infer<typeof repriceAgreementSchema>
export type PriceAgreementFilters = z.infer<typeof priceAgreementFiltersSchema>
