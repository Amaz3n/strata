import { z } from "zod"

export const punchItemStatusEnum = z.enum(["open", "in_progress", "ready_for_review", "closed"])

export const punchItemCreateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500),
  description: z.string().max(10_000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  severity: z.string().max(80).nullable().optional(),
  due_date: z.string().date().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  assigned_company_id: z.string().uuid().nullable().optional(),
  verification_required: z.boolean().nullable().optional(),
})

export const punchItemUpdateSchema = punchItemCreateSchema.partial().extend({
  status: punchItemStatusEnum.optional(),
  back_charge_flag: z.boolean().nullable().optional(),
  verification_notes: z.string().max(10_000).nullable().optional(),
})

export const punchItemBulkAssignSchema = z.object({
  punch_item_ids: z.array(z.string().uuid()).max(500),
  company_id: z.string().uuid(),
})

export type PunchItemCreateInput = z.input<typeof punchItemCreateSchema>
export type PunchItemUpdateInput = z.input<typeof punchItemUpdateSchema>
