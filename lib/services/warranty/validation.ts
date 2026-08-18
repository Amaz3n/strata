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

/** Opt-out for a deliberate double-booking; the conflict itself is always surfaced first. */
export const warrantyScheduleOverrideSchema = z.object({
  allow_conflict: z.boolean().optional(),
})

export const warrantyVisitVerifySchema = z.object({
  visit_id: z.string().uuid(),
  resolution_note: nullableText(4000),
})

export type WarrantyVisitCompleteWithCostInput = z.infer<typeof warrantyVisitCompleteWithCostSchema>
export type WarrantyVisitPortalOutcomeInput = z.infer<typeof warrantyVisitPortalOutcomeSchema>
export type WarrantyAcknowledgeInput = z.infer<typeof warrantyAcknowledgeSchema>
