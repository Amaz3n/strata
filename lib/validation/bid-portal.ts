import { z } from "zod"

import { bidSubmissionItemResponseEnum } from "@/lib/validation/bids"

export const bidPortalPinSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4,6}$/, "PIN must be 4-6 digits")

export const bidPortalSubmissionItemSchema = z.object({
  bid_scope_item_id: z.string().uuid(),
  response: bidSubmissionItemResponseEnum.default("priced"),
  amount_cents: z.number().int().nullable().optional(),
  unit_rate_cents: z.number().int().nullable().optional(),
  quantity: z.number().nullable().optional(),
  notes: z.string().max(2000).optional().nullable(),
})

export const bidPortalSubmissionInputSchema = z.object({
  total_cents: z.number().int().positive(),
  currency: z.string().trim().min(1).optional(),
  valid_until: z.string().optional().nullable(),
  lead_time_days: z.number().int().nonnegative().optional().nullable(),
  duration_days: z.number().int().nonnegative().optional().nullable(),
  start_available_on: z.string().optional().nullable(),
  exclusions: z.string().optional().nullable(),
  clarifications: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  submitted_by_name: z.string().trim().min(1, "Name is required"),
  submitted_by_email: z.string().trim().email("Valid email is required"),
  file_ids: z.array(z.string().uuid()).optional(),
  items: z.array(bidPortalSubmissionItemSchema).max(300).optional(),
})

export type BidPortalSubmissionInput = z.infer<typeof bidPortalSubmissionInputSchema>

export const bidPortalDraftSchema = z.object({
  payload: z.record(z.unknown()),
})

export const bidPortalWithdrawSchema = z.object({
  reason: z.string().trim().max(2000).optional().nullable(),
})
