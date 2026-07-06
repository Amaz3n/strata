import { z } from "zod"

export const bidPackageStatusEnum = z.enum(["draft", "sent", "open", "closed", "awarded", "cancelled"])
export type BidPackageStatus = z.infer<typeof bidPackageStatusEnum>

export const bidInviteStatusEnum = z.enum(["draft", "sent", "viewed", "declined", "submitted", "withdrawn"])
export type BidInviteStatus = z.infer<typeof bidInviteStatusEnum>

export const bidSubmissionStatusEnum = z.enum(["draft", "submitted", "revised", "withdrawn"])
export type BidSubmissionStatus = z.infer<typeof bidSubmissionStatusEnum>

export const createBidPackageInputSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    prospect_id: z.string().uuid().optional().nullable(),
    title: z.string().min(1, "Title is required"),
    cost_code_id: z.string().uuid().optional().nullable(),
    budget_line_id: z.string().uuid().optional().nullable(),
    trade: z.string().optional().nullable(),
    scope: z.string().optional().nullable(),
    instructions: z.string().optional().nullable(),
    due_at: z.string().datetime().optional().nullable(),
    status: bidPackageStatusEnum.optional(),
  })
  .refine((data) => data.project_id || data.prospect_id, {
    message: "A bid package must belong to a project or prospect",
  })

export const updateBidPackageInputSchema = z.object({
  title: z.string().min(1).optional(),
  cost_code_id: z.string().uuid().optional().nullable(),
  budget_line_id: z.string().uuid().optional().nullable(),
  trade: z.string().optional().nullable(),
  scope: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
  due_at: z.string().datetime().optional().nullable(),
  status: bidPackageStatusEnum.optional(),
})

export const createBidInviteInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  company_id: z.string().uuid(),
  contact_id: z.string().uuid().optional().nullable(),
  invite_email: z.string().email().optional().nullable(),
  status: bidInviteStatusEnum.optional(),
})

export const bulkBidInviteItemSchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  invite_email: z.string().email().optional().nullable(),
  // For email-only invites (new vendors not in directory)
  company_name: z.string().optional().nullable(),
}).refine(
  (data) => data.company_id || data.invite_email,
  { message: "Either company_id or invite_email is required" }
)

export const bulkCreateBidInvitesInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  invites: z.array(bulkBidInviteItemSchema).min(1, "At least one invite is required"),
  send_emails: z.boolean().default(true),
})

export const createBidAddendumInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  title: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
})

export const awardBidSubmissionInputSchema = z.object({
  bid_submission_id: z.string().uuid(),
  notes: z.string().optional().nullable(),
})

export const bidSubmissionLineItemSchema = z.object({
  description: z.string().trim().min(1, "Line item description is required"),
  amount_cents: z.number().int(),
  notes: z.string().trim().optional().nullable(),
})

export const manualBidSubmissionInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  bid_invite_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  invite_email: z.string().email().optional().nullable(),
  total_cents: z.number().int().min(0),
  currency: z.string().trim().min(1).default("usd"),
  valid_until: z.string().optional().nullable(),
  lead_time_days: z.number().int().nonnegative().optional().nullable(),
  duration_days: z.number().int().nonnegative().optional().nullable(),
  start_available_on: z.string().optional().nullable(),
  exclusions: z.string().optional().nullable(),
  clarifications: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  submitted_by_name: z.string().trim().optional().nullable(),
  submitted_by_email: z.string().trim().email().optional().nullable(),
  leveled_adjustment_cents: z.number().int().default(0),
  leveling_notes: z.string().optional().nullable(),
  line_items: z.array(bidSubmissionLineItemSchema).default([]),
}).refine(
  (data) => data.bid_invite_id || data.company_id,
  { message: "Select an existing invite or company for the manual bid" },
)

export const updateBidSubmissionLevelingInputSchema = z.object({
  bid_submission_id: z.string().uuid(),
  leveled_adjustment_cents: z.number().int().default(0),
  leveling_notes: z.string().optional().nullable(),
  line_items: z.array(bidSubmissionLineItemSchema).optional(),
})

export const answerBidPackageRfiInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  rfi_id: z.string().uuid(),
  body: z.string().trim().min(1, "Answer is required"),
  broadcast_as_addendum: z.boolean().default(true),
})
