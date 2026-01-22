import { z } from "zod"

// Lead status enum - kept minimal per MVP spec
export const leadStatusEnum = z.enum(["new", "contacted", "qualified", "estimating", "won", "lost"])
export type LeadStatus = z.infer<typeof leadStatusEnum>

export const leadPriorityEnum = z.enum(["low", "normal", "high", "urgent"])
export type LeadPriority = z.infer<typeof leadPriorityEnum>

export const leadProjectTypeEnum = z.enum(["new_construction", "remodel", "addition", "other"])
export type LeadProjectType = z.infer<typeof leadProjectTypeEnum>

export const leadBudgetRangeEnum = z.enum(["under_100k", "100k_250k", "250k_500k", "500k_1m", "over_1m", "undecided"])
export type LeadBudgetRange = z.infer<typeof leadBudgetRangeEnum>

export const leadTimelineEnum = z.enum(["asap", "3_months", "6_months", "1_year", "flexible"])
export type LeadTimeline = z.infer<typeof leadTimelineEnum>

export const touchTypeEnum = z.enum(["note", "call", "meeting", "site_visit", "email"])
export type TouchType = z.infer<typeof touchTypeEnum>

// CRM metadata stored in contacts.metadata
export const crmMetadataSchema = z.object({
  lead_status: leadStatusEnum.optional(),
  lead_priority: leadPriorityEnum.optional(),
  lead_owner_user_id: z.string().uuid().optional(),
  next_follow_up_at: z.string().datetime().optional().nullable(),
  last_contacted_at: z.string().datetime().optional().nullable(),
  lead_lost_reason: z.string().optional(),
  lead_project_type: leadProjectTypeEnum.optional(),
  lead_budget_range: leadBudgetRangeEnum.optional(),
  lead_timeline_preference: leadTimelineEnum.optional(),
  lead_tags: z.array(z.string()).optional(),
  jobsite_location: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
  }).optional(),
})

export type CrmMetadata = z.infer<typeof crmMetadataSchema>

// Input for creating a prospect (extends contact with CRM fields)
export const createProspectInputSchema = z.object({
  full_name: z.string().min(2, "Full name is required"),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  role: z.string().optional(),
  notes: z.string().max(2000).optional(),
  crm_source: z.string().optional(),
  // CRM-specific fields
  lead_status: leadStatusEnum.default("new"),
  lead_priority: leadPriorityEnum.default("normal"),
  lead_owner_user_id: z.string().uuid().optional(),
  next_follow_up_at: z.string().datetime().optional().nullable(),
  lead_project_type: leadProjectTypeEnum.optional(),
  lead_budget_range: leadBudgetRangeEnum.optional(),
  lead_timeline_preference: leadTimelineEnum.optional(),
  lead_tags: z.array(z.string()).optional(),
  jobsite_location: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
  }).optional(),
})

export type CreateProspectInput = z.infer<typeof createProspectInputSchema>

// Input for updating prospect CRM fields
export const updateProspectInputSchema = z.object({
  lead_status: leadStatusEnum.optional(),
  lead_priority: leadPriorityEnum.optional(),
  lead_owner_user_id: z.string().uuid().optional().nullable(),
  next_follow_up_at: z.string().datetime().optional().nullable(),
  lead_lost_reason: z.string().optional(),
  lead_project_type: leadProjectTypeEnum.optional(),
  lead_budget_range: leadBudgetRangeEnum.optional(),
  lead_timeline_preference: leadTimelineEnum.optional(),
  lead_tags: z.array(z.string()).optional(),
  jobsite_location: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
  }).optional(),
})

export type UpdateProspectInput = z.infer<typeof updateProspectInputSchema>

// Input for adding a touch/activity
export const addTouchInputSchema = z.object({
  contact_id: z.string().uuid(),
  touch_type: touchTypeEnum,
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
})

export type AddTouchInput = z.infer<typeof addTouchInputSchema>

// Input for setting follow-up
export const setFollowUpInputSchema = z.object({
  contact_id: z.string().uuid(),
  next_follow_up_at: z.string().datetime().nullable(),
})

export type SetFollowUpInput = z.infer<typeof setFollowUpInputSchema>

// Filters for prospect list
export const prospectFiltersSchema = z.object({
  lead_status: leadStatusEnum.optional(),
  lead_priority: leadPriorityEnum.optional(),
  lead_owner_user_id: z.string().uuid().optional(),
  follow_up_overdue: z.boolean().optional(),
  follow_up_today: z.boolean().optional(),
  search: z.string().optional(),
}).optional()

export type ProspectFilters = z.infer<typeof prospectFiltersSchema>

// Status change input
export const changeStatusInputSchema = z.object({
  contact_id: z.string().uuid(),
  lead_status: leadStatusEnum,
  lead_lost_reason: z.string().optional(),
})

export type ChangeStatusInput = z.infer<typeof changeStatusInputSchema>
