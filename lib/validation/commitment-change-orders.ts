import { z } from "zod"

export const commitmentChangeOrderStatusEnum = z.enum([
  "draft",
  "sent",
  "approved",
  "rejected",
  "voided",
])

export const commitmentChangeOrderLineInputSchema = z.object({
  commitment_line_id: z.string().uuid().nullable().optional(),
  cost_code_id: z.string().uuid().nullable().optional(),
  budget_line_id: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1, "Description is required"),
  quantity: z.number().positive().default(1),
  unit: z.string().trim().nullable().optional(),
  unit_cost_cents: z.number().int(),
  sort_order: z.number().int().nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
})

export const commitmentChangeOrderInputSchema = z.object({
  commitment_id: z.string().uuid(),
  reason_code_id: z.string().uuid().nullable().optional(),
  origin: z.enum(["field_mobile", "office", "design_studio_co", "trade_portal"]).nullable().optional(),
  requested_by: z.string().uuid().nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).default([]),
  title: z.string().trim().min(2, "Title is required").max(255),
  description: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  lines: z.array(commitmentChangeOrderLineInputSchema).min(1, "Add at least one line"),
})

export const commitmentChangeOrderUpdateSchema = z.object({
  reason_code_id: z.string().uuid().nullable().optional(),
  origin: z.enum(["field_mobile", "office", "design_studio_co", "trade_portal"]).nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).optional(),
  title: z.string().trim().min(2, "Title is required").max(255).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  lines: z.array(commitmentChangeOrderLineInputSchema).min(1, "Add at least one line").optional(),
})

export const commitmentChangeOrderFromClientChangeOrderSchema = z.object({
  change_order_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  title: z.string().trim().min(2).max(255).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
})

export const commitmentChangeOrderLinkSchema = z.object({
  change_order_id: z.string().uuid(),
  commitment_change_order_id: z.string().uuid(),
})

export type CommitmentChangeOrderInput = z.infer<typeof commitmentChangeOrderInputSchema>
export type CommitmentChangeOrderUpdateInput = z.infer<typeof commitmentChangeOrderUpdateSchema>
export type CommitmentChangeOrderLineInput = z.infer<typeof commitmentChangeOrderLineInputSchema>
export type CommitmentChangeOrderFromClientChangeOrderInput = z.infer<
  typeof commitmentChangeOrderFromClientChangeOrderSchema
>
export type CommitmentChangeOrderLinkInput = z.infer<typeof commitmentChangeOrderLinkSchema>
