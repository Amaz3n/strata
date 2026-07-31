import { z } from "zod"

export const changeEventLineSchema = z.object({
  cost_code_id: z.string().uuid().nullable().optional(),
  budget_line_id: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(2).max(1000),
  quantity: z.number().nonnegative().default(1),
  uom: z.string().trim().max(30).nullable().optional(),
  unit_cost_cents: z.number().int().nonnegative().default(0),
  rom_cents: z.number().int().nonnegative().default(0),
})

export const createChangeEventSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().trim().min(3).max(250),
  description: z.string().trim().max(8000).nullable().optional(),
  origin_type: z.enum(["manual", "rfi", "drawing_revision", "selection", "email", "tm_ticket", "inspection"]).default("manual"),
  origin_id: z.string().uuid().nullable().optional(),
  scope: z.enum(["in_scope", "out_of_scope", "tbd"]).default("tbd"),
  rom_cents: z.number().int().nonnegative().default(0),
  lines: z.array(changeEventLineSchema).max(250).default([]),
})

export const priceChangeEventSchema = z.object({
  lines: z.array(changeEventLineSchema).min(1).max(250),
})

export const sendChangeEventRfqsSchema = z.object({
  commitment_ids: z.array(z.string().uuid()).min(1).max(100),
  due_date: z.string().date().nullable().optional(),
})

export const changeEventRfqResponseSchema = z.object({
  amount_cents: z.number().int().nonnegative(),
  notes: z.string().trim().max(8000).nullable().optional(),
  declined: z.boolean().default(false),
})

export type CreateChangeEventInput = z.infer<typeof createChangeEventSchema>
export type PriceChangeEventInput = z.infer<typeof priceChangeEventSchema>
export type SendChangeEventRfqsInput = z.infer<typeof sendChangeEventRfqsSchema>
export type ChangeEventRfqResponseInput = z.infer<typeof changeEventRfqResponseSchema>
