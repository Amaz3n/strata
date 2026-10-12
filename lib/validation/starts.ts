import { z } from "zod"

const mondayDate = z.string().date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return date.getUTCDay() === 1
}, "Week start must be a Monday")

/** A retarget either names a Monday or clears the target entirely. */
export const targetWeekSchema = mondayDate.nullable()

export const startPackageInputSchema = z.object({
  isFinanced: z.boolean().optional().default(false),
  targetWeek: mondayDate.optional().nullable(),
})

export const startPackageUpdateSchema = z.object({
  targetWeek: mondayDate.optional().nullable(),
  scheduledStartDate: z.string().date().optional().nullable(),
  isFinanced: z.boolean().optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export const gateAttestSchema = z.object({
  evidenceFileId: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
})

export const gateWaiveSchema = z.object({ reason: z.string().trim().min(10).max(2000) })

export const releaseInputSchema = z.object({
  scheduledStartDate: z.string().date().refine(
    (value) => value >= new Date().toISOString().slice(0, 10),
    "Scheduled start date cannot be in the past",
  ),
  confirmOverSlot: z.boolean().optional().default(false),
})

export const slotSchema = z.object({
  weekStart: mondayDate,
  targetStarts: z.number().int().min(0).max(20),
  notes: z.string().trim().max(1000).optional().nullable(),
})

export const gateDefinitionSchema = z.object({
  id: z.string().uuid().optional(),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional().nullable(),
  checkKind: z.enum(["auto", "manual"]),
  autoSource: z.enum([
    "selections_locked", "budget_generated", "pos_generated", "plan_pinned",
    "plot_plan_file", "po_exceptions_clear", "entitlements_clear", "agreement_milestones_clear", "permit_approved",
  ]).optional().nullable(),
  requiresAttestationPermission: z.string().trim().max(100).optional().nullable(),
  appliesWhen: z.enum(["always", "financed_only", "purchasing_enabled"]).default("always"),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.checkKind === "auto" && !value.autoSource) {
    context.addIssue({ code: "custom", path: ["autoSource"], message: "Auto gates require a source" })
  }
  if (value.checkKind === "manual" && value.autoSource) {
    context.addIssue({ code: "custom", path: ["autoSource"], message: "Manual gates cannot use an auto source" })
  }
})

export const lookaheadSchema = z.object({
  divisionId: z.string().uuid().optional(),
  weeks: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  communityId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  page: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(100).optional().default(50),
})

export const tradeLookaheadWorkspaceSchema = lookaheadSchema.extend({
  q: z.string().trim().max(120).optional().default(""),
  group: z.string().max(500).optional(),
  itemPage: z.number().int().safe().positive().max(1000000).optional().default(1),
  page: z.number().int().safe().positive().max(1000000).optional().default(1),
})

/** Runtime proof for a dynamic embedded projection; malformed source is not an empty page. */
export const tradeSchedulePageSchema = z.array(z.object({
  id: z.string().min(1), project_id: z.string().min(1), name: z.string(),
  trade: z.string().nullable().optional().default(null),
  status: z.string().optional().default("planned"),
  start_date: z.string().date(), end_date: z.string().date().nullable().optional().default(null),
  cost_code_id: z.string().nullable().optional().default(null), project: z.unknown(),
  assignments: z.array(z.object({ company_id: z.string().nullable().optional(), confirmed_at: z.string().nullable().optional(), company: z.unknown() })).optional().default([]),
})).max(100)

const tradeSummaryReply = z.object({
  key: z.string().max(500), companyId: z.string().uuid().nullable(), companyName: z.string(), trade: z.string().nullable(),
  itemCount: z.number().int().safe().positive(), confirmedCount: z.number().int().safe().nonnegative(), firstDate: z.string().date(),
})
const tradeTaskReply = z.object({
  scheduleItemId: z.string().uuid(), projectId: z.string().uuid(), lotLabel: z.string(), communityName: z.string(), name: z.string(),
  startDate: z.string().date(), endDate: z.string().date(), status: z.string(), confirmation: z.enum(["confirmed", "unsent"]),
})
export const tradeWorkspaceReplySchema = z.object({
  orgId: z.string().uuid(), actorId: z.string().uuid(), divisionId: z.string().uuid().nullable(), communityId: z.string().uuid().nullable(),
  weeks: z.union([z.literal(2),z.literal(3),z.literal(4)]), q: z.string().max(120), group: z.string().max(500).nullable(),
  page: z.number().int().safe().positive(), pageSize: z.literal(50), itemPage: z.number().int().safe().positive(), itemPageSize: z.literal(50), total: z.number().int().safe().nonnegative(),
  rows: z.array(tradeSummaryReply).max(50), selected: tradeSummaryReply.extend({ items: z.array(tradeTaskReply).max(50) }).nullable(), selectedUnavailable: z.boolean(),
})

export type GateDefinitionInput = z.infer<typeof gateDefinitionSchema>
