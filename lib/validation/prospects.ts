import { z } from "zod"

import { ACTIVITY_KINDS, INQUIRY_CHANNELS } from "@/lib/sales/activity"
import { LOST_REASON_CODES } from "@/lib/sales/lost-reasons"

export const prospectStatusEnum = z.enum([
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
  "won",
  "lost",
])
export type ProspectStatus = z.infer<typeof prospectStatusEnum>

export const prospectJobsiteLocationSchema = z
  .object({
    street: z.string().trim().optional(),
    city: z.string().trim().optional(),
    state: z.string().trim().optional(),
    postal_code: z.string().trim().optional(),
  })
  .optional()
  .nullable()

export const prospectContactInputSchema = z.object({
  full_name: z.string().trim().min(2, "Contact name is required"),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  role: z.string().trim().optional().nullable(),
  company_name: z.string().trim().optional().nullable(),
  is_primary: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type ProspectContactInput = z.infer<typeof prospectContactInputSchema>

export const createProspectInputSchema = z.object({
  name: z.string().trim().min(2, "Prospect name is required"),
  status: prospectStatusEnum.default("new"),
  owner_user_id: z.string().uuid().optional().nullable(),
  community_id: z.string().uuid().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  jobsite_location: prospectJobsiteLocationSchema,
  project_type: z.string().trim().optional().nullable(),
  budget_range: z.string().trim().optional().nullable(),
  timeline_preference: z.string().trim().optional().nullable(),
  tags: z.array(z.string().trim().min(1)).optional(),
  notes: z.string().trim().max(10000).optional().nullable(),
  primary_contact: prospectContactInputSchema.optional(),
})
export type CreateProspectInput = z.infer<typeof createProspectInputSchema>

export const updateProspectInputSchema = z.object({
  name: z.string().trim().min(2).optional(),
  status: prospectStatusEnum.optional(),
  owner_user_id: z.string().uuid().optional().nullable(),
  community_id: z.string().uuid().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  jobsite_location: prospectJobsiteLocationSchema,
  project_type: z.string().trim().optional().nullable(),
  budget_range: z.string().trim().optional().nullable(),
  timeline_preference: z.string().trim().optional().nullable(),
  tags: z.array(z.string().trim().min(1)).optional(),
  notes: z.string().trim().max(10000).optional().nullable(),
  lost_reason: z.string().trim().max(2000).optional().nullable(),
  next_follow_up_at: z.string().trim().min(1).optional().nullable(),
})
export type UpdateProspectInput = z.infer<typeof updateProspectInputSchema>

export const logProspectContactInputSchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  note: z.string().trim().max(2000).optional().nullable(),
  occurredAt: z.string().datetime().optional().nullable(),
})
export type LogProspectContactInput = z.infer<typeof logProspectContactInputSchema>

/**
 * What a consultant can correct on a deal from the Sales desk: everything the
 * registration card captured, in the same shape, so the two forms cannot disagree
 * about what a lead is made of.
 *
 * Absent on purpose: the arrival channel and the visit date. Those moved that
 * day's community traffic tally when the lead was registered, and editing them
 * later would leave the tally saying something the leads no longer support.
 */
export const updateDealDetailsInputSchema = z.object({
  fullName: z.string().trim().min(2, "Buyer name is required"),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().email("Enter a valid email").optional().nullable().or(z.literal("")),
  ownerUserId: z.string().uuid().optional().nullable(),
  communityId: z.string().uuid().optional().nullable(),
  source: z.string().trim().max(120).optional().nullable(),
  planInterest: z.string().trim().max(120).optional().nullable(),
  priceRange: z.string().trim().max(120).optional().nullable(),
  timeframe: z.string().trim().max(120).optional().nullable(),
  coopAgentName: z.string().trim().max(160).optional().nullable(),
  coopBrokerage: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(10000).optional().nullable(),
})
export type UpdateDealDetailsInput = z.infer<typeof updateDealDetailsInputSchema>

export const markProspectLostInputSchema = z.object({
  reasonCode: z.enum(LOST_REASON_CODES),
  note: z.string().trim().max(1000).optional().nullable(),
})
export type MarkProspectLostInput = z.infer<typeof markProspectLostInputSchema>

/**
 * A model-home registration card: what a walk-in fills in on the clipboard.
 * Co-op agent and brokerage become a secondary prospect contact — a co-op broker
 * is a person on the deal, not a field on it.
 */
export const productionInquiryInputSchema = z.object({
  buyerName: z.string().trim().min(2, "Buyer name is required"),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().email("Enter a valid email").optional().nullable().or(z.literal("")),
  communityId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid().optional().nullable(),
  channel: z.enum(INQUIRY_CHANNELS),
  source: z.string().trim().max(120).optional().nullable(),
  planInterest: z.string().trim().max(120).optional().nullable(),
  priceRange: z.string().trim().max(120).optional().nullable(),
  timeframe: z.string().trim().max(120).optional().nullable(),
  coopAgentName: z.string().trim().max(160).optional().nullable(),
  coopBrokerage: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(10000).optional().nullable(),
  /** Local calendar day of the visit, so the traffic tally lands on the right date. */
  loggedDate: z.string().date(),
})
export type ProductionInquiryInput = z.infer<typeof productionInquiryInputSchema>

export const updateProspectContactInputSchema = prospectContactInputSchema.partial().extend({
  contact_id: z.string().uuid().optional().nullable(),
  promoted_contact_id: z.string().uuid().optional().nullable(),
})
export type UpdateProspectContactInput = z.infer<typeof updateProspectContactInputSchema>

export const prospectFiltersSchema = z
  .object({
    status: prospectStatusEnum.optional(),
    owner_user_id: z.string().uuid().optional(),
    community_id: z.string().uuid().optional(),
    search: z.string().trim().optional(),
  })
  .optional()
export type ProspectFilters = z.infer<typeof prospectFiltersSchema>
