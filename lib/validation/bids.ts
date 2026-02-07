import { z } from "zod"

export const bidPackageStatusEnum = z.enum(["draft", "sent", "open", "closed", "awarded", "cancelled"])
export type BidPackageStatus = z.infer<typeof bidPackageStatusEnum>

export const bidInviteStatusEnum = z.enum(["draft", "sent", "viewed", "declined", "submitted", "withdrawn"])
export type BidInviteStatus = z.infer<typeof bidInviteStatusEnum>

export const bidSubmissionStatusEnum = z.enum(["draft", "submitted", "revised", "withdrawn"])
export type BidSubmissionStatus = z.infer<typeof bidSubmissionStatusEnum>

export const createBidPackageInputSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1, "Title is required"),
  trade: z.string().optional().nullable(),
  scope: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
  due_at: z.string().datetime().optional().nullable(),
  status: bidPackageStatusEnum.optional(),
})

export const updateBidPackageInputSchema = z.object({
  title: z.string().min(1).optional(),
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
