import { z } from "zod"

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

export const updateProspectContactInputSchema = prospectContactInputSchema.partial().extend({
  contact_id: z.string().uuid().optional().nullable(),
  promoted_contact_id: z.string().uuid().optional().nullable(),
})
export type UpdateProspectContactInput = z.infer<typeof updateProspectContactInputSchema>

export const prospectFiltersSchema = z
  .object({
    status: prospectStatusEnum.optional(),
    owner_user_id: z.string().uuid().optional(),
    search: z.string().trim().optional(),
  })
  .optional()
export type ProspectFilters = z.infer<typeof prospectFiltersSchema>
