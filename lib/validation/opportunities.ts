import { z } from "zod"

export const opportunityStatusEnum = z.enum([
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
  "won",
  "lost",
])
export type OpportunityStatus = z.infer<typeof opportunityStatusEnum>

export const jobsiteLocationSchema = z
  .object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
  })
  .optional()

export const createOpportunityInputSchema = z.object({
  name: z.string().min(2, "Opportunity name is required"),
  client_contact_id: z.string().uuid(),
  status: opportunityStatusEnum.default("new"),
  owner_user_id: z.string().uuid().optional().nullable(),
  jobsite_location: jobsiteLocationSchema,
  project_type: z.string().optional().nullable(),
  budget_range: z.string().optional().nullable(),
  timeline_preference: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(5000).optional().nullable(),
})

export type CreateOpportunityInput = z.infer<typeof createOpportunityInputSchema>

export const updateOpportunityInputSchema = z.object({
  name: z.string().min(2).optional(),
  status: opportunityStatusEnum.optional(),
  owner_user_id: z.string().uuid().optional().nullable(),
  jobsite_location: jobsiteLocationSchema,
  project_type: z.string().optional().nullable(),
  budget_range: z.string().optional().nullable(),
  timeline_preference: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(5000).optional().nullable(),
})

export type UpdateOpportunityInput = z.infer<typeof updateOpportunityInputSchema>

export const opportunityFiltersSchema = z
  .object({
    status: opportunityStatusEnum.optional(),
    owner_user_id: z.string().uuid().optional(),
    search: z.string().optional(),
  })
  .optional()

export type OpportunityFilters = z.infer<typeof opportunityFiltersSchema>
