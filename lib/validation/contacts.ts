import { z } from "zod"

import type { ContactType } from "@/lib/types"

export const contactTypeEnum = z.enum(["internal", "subcontractor", "client", "vendor", "consultant"]) satisfies z.ZodType<ContactType>

export const contactInputSchema = z.object({
  full_name: z.string().min(2, "Full name is required"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().max(400).optional(),
  role: z.string().optional(),
  contact_type: contactTypeEnum.default("subcontractor"),
  primary_company_id: z.string().uuid().optional(),
  has_portal_access: z.boolean().optional(),
  preferred_contact_method: z.enum(["phone", "email", "text"]).optional(),
  notes: z.string().max(2000).optional(),
  external_crm_id: z.string().optional(),
  crm_source: z.string().optional(),
})

export const contactUpdateSchema = contactInputSchema.partial()

export const contactFiltersSchema = z
  .object({
    contact_type: contactTypeEnum.optional(),
    company_id: z.string().uuid().optional(),
    search: z.string().optional(),
  })
  .optional()

export const contactCompanyLinkSchema = z.object({
  contact_id: z.string().uuid(),
  company_id: z.string().uuid(),
  relationship: z.string().optional(),
})

export type ContactInput = z.infer<typeof contactInputSchema>
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>
export type ContactFilters = z.infer<typeof contactFiltersSchema>
export type ContactCompanyLinkInput = z.infer<typeof contactCompanyLinkSchema>






