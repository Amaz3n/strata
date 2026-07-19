import { z } from "zod"

const mondayDate = z.string().date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return date.getUTCDay() === 1
}, "Week start must be a Monday")

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
    "plot_plan_file", "po_exceptions_clear",
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
  weeks: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  communityId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  page: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(100).optional().default(50),
})

export type GateDefinitionInput = z.infer<typeof gateDefinitionSchema>
