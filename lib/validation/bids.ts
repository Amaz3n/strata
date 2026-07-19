import { z } from "zod"

export const bidPackageStatusEnum = z.enum(["draft", "sent", "open", "closed", "awarded", "cancelled"])
export type BidPackageStatus = z.infer<typeof bidPackageStatusEnum>

export const bidInviteStatusEnum = z.enum(["draft", "sent", "viewed", "declined", "submitted", "withdrawn"])
export type BidInviteStatus = z.infer<typeof bidInviteStatusEnum>

export const bidSubmissionStatusEnum = z.enum(["draft", "submitted", "revised", "withdrawn"])
export type BidSubmissionStatus = z.infer<typeof bidSubmissionStatusEnum>

export const bidPackageModeEnum = z.enum(["quote", "tender"])
export type BidPackageMode = z.infer<typeof bidPackageModeEnum>

export const bidScopeItemTypeEnum = z.enum(["base", "alternate", "allowance", "unit_price"])
export type BidScopeItemType = z.infer<typeof bidScopeItemTypeEnum>

export const bidSubmissionItemResponseEnum = z.enum(["priced", "excluded", "no_bid"])
export type BidSubmissionItemResponse = z.infer<typeof bidSubmissionItemResponseEnum>

export const createBidPackageInputSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    prospect_id: z.string().uuid().optional().nullable(),
    community_id: z.string().uuid().optional().nullable(),
    house_plan_id: z.string().uuid().optional().nullable(),
    award_target: z.enum(["commitment", "price_agreement"]).optional(),
    title: z.string().min(1, "Title is required"),
    cost_code_id: z.string().uuid().optional().nullable(),
    budget_line_id: z.string().uuid().optional().nullable(),
    trade: z.string().optional().nullable(),
    scope: z.string().optional().nullable(),
    instructions: z.string().optional().nullable(),
    due_at: z.string().datetime().optional().nullable(),
    due_tz: z.string().optional().nullable(),
    mode: bidPackageModeEnum.optional(),
    bond_required: z.boolean().optional(),
    status: bidPackageStatusEnum.optional(),
  })
  .superRefine((data, context) => {
    const contexts = Number(Boolean(data.project_id)) + Number(Boolean(data.prospect_id))
      + Number(Boolean(data.community_id || data.house_plan_id))
    if (contexts !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose one project, prospect, or community/plan context." })
    if ((data.community_id || data.house_plan_id) && data.award_target && data.award_target !== "price_agreement") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["award_target"], message: "Community/plan packages award to the price book." })
    }
  })

export const updateBidPackageInputSchema = z.object({
  community_id: z.string().uuid().optional().nullable(),
  house_plan_id: z.string().uuid().optional().nullable(),
  award_target: z.enum(["commitment", "price_agreement"]).optional(),
  title: z.string().min(1).optional(),
  cost_code_id: z.string().uuid().optional().nullable(),
  budget_line_id: z.string().uuid().optional().nullable(),
  trade: z.string().optional().nullable(),
  scope: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
  due_at: z.string().datetime().optional().nullable(),
  due_tz: z.string().optional().nullable(),
  mode: bidPackageModeEnum.optional(),
  bond_required: z.boolean().optional(),
  status: bidPackageStatusEnum.optional(),
})

export const bidScopeItemInputSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  item_type: bidScopeItemTypeEnum.default("base"),
  description: z.string().trim().min(1, "Scope description is required"),
  details: z.string().optional().nullable(),
  quantity: z.number().positive().optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  budget_cents: z.number().int().optional().nullable(),
  cost_code_id: z.string().uuid().optional().nullable(),
})

export const saveBidScopeItemsInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  items: z.array(bidScopeItemInputSchema).max(200),
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
  accepted_alternate_ids: z.array(z.string().uuid()).default([]),
})

export const rescindBidAwardInputSchema = z.object({
  bid_package_id: z.string().uuid(),
  reason: z.string().trim().min(1, "A rescind reason is required"),
})

export const bidSubmissionItemInputSchema = z.object({
  bid_scope_item_id: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(1),
  response: bidSubmissionItemResponseEnum.default("priced"),
  amount_cents: z.number().int().optional().nullable(),
  unit_rate_cents: z.number().int().optional().nullable(),
  quantity: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export const updateBidSubmissionItemLevelingInputSchema = z.object({
  bid_submission_item_id: z.string().uuid(),
  gc_plug_cents: z.number().int().optional().nullable(),
  gc_note: z.string().optional().nullable(),
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
  items: z.array(bidSubmissionItemInputSchema).default([]),
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
