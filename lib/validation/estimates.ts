import { z } from "zod"

export const PRICING_DISPLAY_MODES = ["itemized", "subtotals", "lump_sum"] as const
export type PricingDisplayMode = (typeof PRICING_DISPLAY_MODES)[number]

export const estimatePhotoSchema = z.object({
  /** R2 storage path (org-scoped). */
  path: z.string().min(1),
  caption: z.string().trim().max(280).optional().nullable(),
})
export type EstimatePhotoInput = z.infer<typeof estimatePhotoSchema>

export const estimateLineInputSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().min(0),
  unit_cost_cents: z.number().min(0),
  item_type: z.enum(["line", "group"]).default("line"),
  cost_code_id: z.string().uuid().optional(),
  markup_pct: z.number().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
  /** Client-selectable upgrade/add-on; excluded from the base total. */
  is_optional: z.boolean().optional(),
  /** Allowance line: included in the total as a placeholder budget the client can reallocate. */
  is_allowance: z.boolean().optional(),
  /** Sub bid this line's cost basis was pulled from (estimate builder "Use bid"). */
  source_bid_submission_id: z.string().uuid().optional(),
})

export const estimateInputSchema = z.object({
  title: z.string().min(1, "Title is required"),
  project_id: z.string().uuid().optional().nullable(),
  prospect_id: z.string().uuid().optional().nullable(),
  recipient_contact_id: z.string().uuid().optional().nullable(),
  // Ad-hoc recipient (prospect estimates have no directory contact); stored on the estimate.
  recipient_name: z.string().trim().min(1).optional().nullable(),
  recipient_email: z.string().trim().email().optional().nullable(),
  summary: z.string().optional(),
  terms: z.string().optional(),
  /** Cover note shown above the line items in the portal and PDF. */
  intro: z.string().optional(),
  /** Controls how much pricing breakdown the client sees. */
  pricing_display: z.enum(PRICING_DISPLAY_MODES).optional(),
  /** Interactive portal gallery (stored as R2 paths on the estimate). */
  photos: z.array(estimatePhotoSchema).optional(),
  valid_until: z.string().optional(),
  tax_rate: z.number().optional(),
  markup_percent: z.number().optional(),
  lines: z.array(estimateLineInputSchema).min(1, "At least one line is required"),
})

export type EstimateInput = z.infer<typeof estimateInputSchema>
