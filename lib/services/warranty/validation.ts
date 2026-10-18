import { z } from "zod"

import { warrantyVisitCompleteSchema } from "@/lib/validation/warranty"
import { TRADE_REPORTABLE_OUTCOMES } from "@/lib/services/warranty/domain"

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()

/**
 * Internal cost captured when a visit is closed out. Self-performed labor and
 * materials are the majority of warranty spend for a builder whose own techs do
 * the work, and nothing else in the system records them.
 */
export const warrantyVisitInternalCostSchema = z.object({
  labor_hours: z.number().nonnegative().max(24).nullable().optional(),
  labor_rate_cents: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
  material_cents: z.number().int().nonnegative().max(100_000_000).optional(),
})

export const warrantyVisitCompleteWithCostSchema = warrantyVisitCompleteSchema.merge(
  warrantyVisitInternalCostSchema,
)

/**
 * Trades report what actually happened. Coverage determinations stay internal,
 * so the portal outcome list is narrower than the office one.
 */
export const warrantyVisitPortalOutcomeSchema = z.object({
  visit_id: z.string().uuid(),
  outcome: z.enum(TRADE_REPORTABLE_OUTCOMES),
  outcome_note: z.string().trim().min(1, "A completion note is required").max(4000),
  photo_file_ids: z.array(z.string().uuid()).max(20).optional(),
})

/** Explicit "we contacted the homeowner" — the event the first-response SLA measures. */
export const warrantyAcknowledgeSchema = z.object({
  request_id: z.string().uuid(),
  channel: z.enum(["phone", "email", "text", "in_person"]),
  note: nullableText(2000),
})

/**
 * Opt-out for a deliberate double-booking; the conflict itself is always
 * surfaced first, and overriding it needs a reason the audit trail can show.
 */
export const warrantyScheduleOverrideSchema = z.object({
  allow_conflict: z.boolean().optional(),
  conflict_reason: nullableText(500),
}).refine((value) => !value.allow_conflict || (value.conflict_reason?.length ?? 0) >= 3, {
  message: "Say why this assignee is being double-booked",
  path: ["conflict_reason"],
})

/** Handing a scheduled visit to another technician or trade: the reason is on the record. */
export const warrantyVisitReassignSchema = z.object({
  visit_id: z.string().uuid(),
  assignee_kind: z.enum(["tech", "trade"]),
  assigned_user_id: z.string().uuid().nullable().optional(),
  assigned_company_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(3, "Say why the visit is being handed off").max(500),
  allow_conflict: z.boolean().optional(),
  conflict_reason: nullableText(500),
}).superRefine((value, ctx) => {
  if (value.assignee_kind === "tech" && (!value.assigned_user_id || value.assigned_company_id)) {
    ctx.addIssue({ code: "custom", path: ["assigned_user_id"], message: "Choose the technician taking the visit" })
  }
  if (value.assignee_kind === "trade" && (!value.assigned_company_id || value.assigned_user_id)) {
    ctx.addIssue({ code: "custom", path: ["assigned_company_id"], message: "Choose the trade taking the visit" })
  }
  if (value.allow_conflict && (value.conflict_reason?.length ?? 0) < 3) {
    ctx.addIssue({ code: "custom", path: ["conflict_reason"], message: "Say why this assignee is being double-booked" })
  }
})

const routingId = z.string().uuid().nullable().optional()

/** A routing rule: the conditions are optional (unset matches anything), the owner is not. */
export const warrantyRoutingRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Name the rule").max(120),
  priority: z.number().int().min(0).max(10_000).default(100),
  severity: z.enum(["emergency", "routine_30", "routine_60"]).nullable().optional(),
  category: z.string().trim().min(1).max(120).nullable().optional(),
  community_id: routingId,
  cost_code_id: routingId,
  assignee_kind: z.enum(["tech", "trade"]),
  assigned_user_id: routingId,
  assigned_company_id: routingId,
  is_active: z.boolean().default(true),
}).superRefine((rule, ctx) => {
  if (rule.assignee_kind === "tech" && (!rule.assigned_user_id || rule.assigned_company_id)) {
    ctx.addIssue({ code: "custom", path: ["assigned_user_id"], message: "Choose the technician who owns matching requests" })
  }
  if (rule.assignee_kind === "trade" && (!rule.assigned_company_id || rule.assigned_user_id)) {
    ctx.addIssue({ code: "custom", path: ["assigned_company_id"], message: "Choose the trade that owns matching requests" })
  }
})

/** Reassigning a request that a rule routed is a decision against the rule; it carries its reason. */
export const warrantyRoutingOverrideReasonSchema = z.string().trim().min(3, "Say why this request is not going to the routed owner").max(500)

/** The homeowner's answer to an appointment. */
export const warrantyBuyerRescheduleRequestSchema = z.object({
  visit_id: z.string().uuid(),
  note: z.string().trim().min(3, "Tell us what time works better").max(1000),
})

export const warrantyVisitVerifySchema = z.object({
  visit_id: z.string().uuid(),
  resolution_note: nullableText(4000),
})

export type WarrantyVisitCompleteWithCostInput = z.infer<typeof warrantyVisitCompleteWithCostSchema>
export type WarrantyVisitPortalOutcomeInput = z.infer<typeof warrantyVisitPortalOutcomeSchema>
export type WarrantyRoutingRuleInput = z.input<typeof warrantyRoutingRuleSchema>
export type WarrantyVisitReassignInput = z.infer<typeof warrantyVisitReassignSchema>
export type WarrantyAcknowledgeInput = z.infer<typeof warrantyAcknowledgeSchema>

/** Why the office will not accept a reported completion — recorded on the request. */
export const warrantyRejectionReasonSchema = z.string().trim().min(3, "Say why the work is not accepted").max(2000)
