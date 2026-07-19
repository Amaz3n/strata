import { z } from "zod"

export const warrantyStatusSchema = z.enum(["open", "in_progress", "resolved", "closed"]).default("open")
export const warrantyPrioritySchema = z.enum(["low", "normal", "high", "urgent"]).default("normal")
export const warrantySeveritySchema = z.enum(["emergency", "routine_30", "routine_60"]).default("routine_30")
export const warrantyCoverageStatusSchema = z.enum(["unclassified", "in_warranty", "out_of_warranty", "goodwill"])

const nullableUuid = z.string().uuid().nullable().optional()
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()

export const warrantyRequestInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: nullableText(4000),
  priority: warrantyPrioritySchema.optional(),
  status: warrantyStatusSchema.optional(),
  severity: warrantySeveritySchema.optional(),
  category: nullableText(100),
  cost_code_id: nullableUuid,
  coverage_term_key: nullableText(100),
  photo_file_ids: z.array(z.string().uuid()).max(20).optional(),
})

export const warrantyRequestUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: nullableText(4000),
  priority: warrantyPrioritySchema.optional(),
  status: warrantyStatusSchema.optional(),
  severity: warrantySeveritySchema.optional(),
  category: nullableText(100),
  cost_code_id: nullableUuid,
  coverage_term_key: nullableText(100),
  coverage_status: warrantyCoverageStatusSchema.optional(),
  coverage_override_reason: nullableText(1000),
  assigned_company_id: nullableUuid,
  assigned_user_id: nullableUuid,
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").nullable().optional(),
  resolution_note: nullableText(4000),
  structural_claim: z.boolean().optional(),
  structural_claim_number: nullableText(200),
  structural_claim_submitted_at: z.string().datetime().nullable().optional(),
})

export const warrantyCoverageTermSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().trim().min(1).max(120),
  duration_months: z.number().int().positive().max(600),
  is_structural: z.boolean().default(false),
  description: nullableText(2000),
})

export const warrantyProgramInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: nullableText(2000),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
  terms: z.array(warrantyCoverageTermSchema).min(1).max(25),
})

export const warrantyCoverageEnrollSchema = z.object({
  project_id: z.string().uuid(),
  program_id: z.string().uuid().optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const warrantySlaTargetsSchema = z.object({
  targets: z.array(z.object({
    severity: warrantySeveritySchema,
    first_response_hours: z.number().int().positive().max(8760),
    resolution_days: z.number().int().positive().max(3650),
  })).length(3),
})

const warrantyVisitScheduleBaseSchema = z.object({
  request_id: z.string().uuid(),
  assignee_kind: z.enum(["tech", "trade"]),
  assigned_user_id: nullableUuid,
  assigned_company_id: nullableUuid,
  window_start: z.string().datetime(),
  window_end: z.string().datetime(),
  note: nullableText(2000),
})

export const warrantyVisitScheduleSchema = warrantyVisitScheduleBaseSchema.superRefine((value, ctx) => {
  if (new Date(value.window_end) <= new Date(value.window_start)) {
    ctx.addIssue({ code: "custom", path: ["window_end"], message: "Visit window must end after it starts" })
  }
  if (value.assignee_kind === "tech" && !value.assigned_user_id) {
    ctx.addIssue({ code: "custom", path: ["assigned_user_id"], message: "Technician is required" })
  }
  if (value.assignee_kind === "trade" && !value.assigned_company_id) {
    ctx.addIssue({ code: "custom", path: ["assigned_company_id"], message: "Trade is required" })
  }
})

export const warrantyVisitRescheduleSchema = warrantyVisitScheduleBaseSchema.pick({
  window_start: true,
  window_end: true,
  note: true,
}).extend({ visit_id: z.string().uuid() }).refine(
  (value) => new Date(value.window_end) > new Date(value.window_start),
  { path: ["window_end"], message: "Visit window must end after it starts" },
)

export const warrantyVisitCompleteSchema = z.object({
  visit_id: z.string().uuid(),
  outcome: z.enum(["resolved", "needs_followup", "needs_parts", "not_warrantable"]),
  outcome_note: nullableText(4000),
  photo_file_ids: z.array(z.string().uuid()).max(20).optional(),
  buyer_signoff_name: nullableText(200),
  buyer_signature_file_id: nullableUuid,
})

export const warrantyVisitPortalCompleteSchema = warrantyVisitCompleteSchema.pick({
  visit_id: true,
  outcome_note: true,
  photo_file_ids: true,
})

export const warrantyBackchargeCostBasisSchema = z.object({
  label: z.string().trim().min(1).max(300),
  amount_cents: z.number().int().positive(),
  ref_type: z.string().trim().max(60).optional(),
  ref_id: z.string().trim().max(200).optional(),
})

export const warrantyBackchargeInputSchema = z.object({
  project_id: z.string().uuid(),
  warranty_request_id: z.string().uuid(),
  company_id: z.string().uuid(),
  commitment_id: nullableUuid,
  cost_code_id: nullableUuid,
  amount_cents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4000),
  cost_basis: z.array(warrantyBackchargeCostBasisSchema).min(1).max(50),
  notes: nullableText(4000),
  confirm_no_ap_history: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.cost_basis.reduce((sum, item) => sum + item.amount_cents, 0) !== value.amount_cents) {
    ctx.addIssue({ code: "custom", path: ["cost_basis"], message: "Cost basis must equal the backcharge amount" })
  }
})

export const warrantyBackchargeDisputeSchema = z.object({
  backcharge_id: z.string().uuid(),
  note: z.string().trim().min(1).max(4000),
})

export const warrantyBackchargeResolveSchema = z.object({
  backcharge_id: z.string().uuid(),
  resolution: z.enum(["recovered", "written_off", "waived"]),
  recovered_cents: z.number().int().nonnegative().optional(),
  note: z.string().trim().min(1).max(4000).optional(),
}).superRefine((value, ctx) => {
  if (value.resolution !== "recovered" && !value.note) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "A resolution note is required" })
  }
})

export type WarrantyRequestInput = z.infer<typeof warrantyRequestInputSchema>
export type WarrantyRequestUpdate = z.infer<typeof warrantyRequestUpdateSchema>
export type WarrantyProgramInput = z.infer<typeof warrantyProgramInputSchema>
export type WarrantyVisitScheduleInput = z.infer<typeof warrantyVisitScheduleSchema>
export type WarrantyVisitCompleteInput = z.infer<typeof warrantyVisitCompleteSchema>
export type WarrantyBackchargeInput = z.infer<typeof warrantyBackchargeInputSchema>
