import { z } from "zod"

export const commitmentChangeOrderStatusEnum = z.enum([
  "draft",
  "sent",
  "approved",
  "rejected",
  "voided",
])

/** The change order columns are 32-bit integers: a single order past this fails in the database, so it is refused here. */
const INT4_MAX = 2_147_483_647
const MAX_LINE_QUANTITY = 1_000_000

export const commitmentChangeOrderLineInputSchema = z.object({
  commitment_line_id: z.string().uuid().nullable().optional(),
  cost_code_id: z.string().uuid().nullable().optional(),
  budget_line_id: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1, "Description is required"),
  quantity: z.number().positive().max(MAX_LINE_QUANTITY).default(1),
  unit: z.string().trim().nullable().optional(),
  unit_cost_cents: z.number().int().min(-INT4_MAX).max(INT4_MAX),
  sort_order: z.number().int().min(0).max(INT4_MAX).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
}).refine((line) => Math.abs(Math.round(line.quantity * line.unit_cost_cents)) <= INT4_MAX, {
  message: "A line cannot exceed 21,474,836.47",
  path: ["unit_cost_cents"],
})

const orderLinesSchema = z.array(commitmentChangeOrderLineInputSchema).min(1, "Add at least one line").refine(
  (lines) => Math.abs(lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents), 0)) <= INT4_MAX,
  { message: "A change order cannot exceed 21,474,836.47" },
)

export const commitmentChangeOrderInputSchema = z.object({
  commitment_id: z.string().uuid(),
  reason_code_id: z.string().uuid().nullable().optional(),
  origin: z.enum(["field_mobile", "office", "design_studio_co", "trade_portal"]).nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).default([]),
  evidence_file_ids: z.array(z.string().uuid()).max(20).default([]),
  title: z.string().trim().min(2, "Title is required").max(255),
  description: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  lines: orderLinesSchema,
})

export const commitmentChangeOrderUpdateSchema = z.object({
  reason_code_id: z.string().uuid().nullable().optional(),
  origin: z.enum(["field_mobile", "office", "design_studio_co", "trade_portal"]).nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).optional(),
  evidence_file_ids: z.array(z.string().uuid()).max(20).optional(),
  title: z.string().trim().min(2, "Title is required").max(255).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  lines: orderLinesSchema.optional(),
  /** Required to re-price a variance order an executed change order raised. */
  reprice_reason: z.string().trim().min(5, "Say why the price changed").max(500).optional(),
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

export type CommitmentChangeOrderInput = z.input<typeof commitmentChangeOrderInputSchema>
export type CommitmentChangeOrderUpdateInput = z.infer<typeof commitmentChangeOrderUpdateSchema>
export type CommitmentChangeOrderLineInput = z.infer<typeof commitmentChangeOrderLineInputSchema>
export type CommitmentChangeOrderFromClientChangeOrderInput = z.infer<
  typeof commitmentChangeOrderFromClientChangeOrderSchema
>
export type CommitmentChangeOrderLinkInput = z.infer<typeof commitmentChangeOrderLinkSchema>
