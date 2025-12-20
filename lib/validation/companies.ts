import { z } from "zod"

import type { CompanyType } from "@/lib/types"

const addressSchema = z
  .object({
    formatted: z.string().optional(),
    street1: z.string().optional(),
    street2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    country: z.string().optional(),
  })
  .optional()

export const companyTypeEnum = z.enum(["subcontractor", "supplier", "client", "architect", "engineer", "other"]) satisfies z.ZodType<CompanyType>

export const companyInputSchema = z.object({
  name: z.string().min(2, "Company name is required"),
  company_type: companyTypeEnum,
  trade: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  website: z.string().url().optional(),
  address: addressSchema,
  license_number: z.string().optional(),
  license_expiry: z.string().optional(),
  license_verified: z.boolean().optional(),
  insurance_expiry: z.string().optional(),
  insurance_document_id: z.string().uuid().optional(),
  w9_on_file: z.boolean().optional(),
  w9_file_id: z.string().uuid().optional(),
  prequalified: z.boolean().optional(),
  prequalified_at: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  default_payment_terms: z.string().max(200).optional(),
  internal_notes: z.string().max(5000).optional(),
  notes: z.string().max(1000).optional(),
})

export const companyUpdateSchema = companyInputSchema.partial()

export const companyFiltersSchema = z
  .object({
    company_type: companyTypeEnum.optional(),
    trade: z.string().optional(),
    search: z.string().optional(),
  })
  .optional()

export type CompanyInput = z.infer<typeof companyInputSchema>
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>
export type CompanyFilters = z.infer<typeof companyFiltersSchema>



