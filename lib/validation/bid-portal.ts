import { z } from "zod"

export const bidPortalPinSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4,6}$/, "PIN must be 4-6 digits")

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
})

export type BidPortalSubmissionInput = z.infer<typeof bidPortalSubmissionInputSchema>
