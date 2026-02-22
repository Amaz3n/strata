import { z } from "zod"

import type { ComplianceDocumentStatus } from "@/lib/types"

// Document type schemas
export const complianceDocTypeInputSchema = z.object({
  name: z.string().min(2, "Name is required"),
  code: z.string().min(2, "Code is required").regex(/^[a-z0-9_]+$/, "Code must be lowercase alphanumeric with underscores"),
  description: z.string().max(500).optional(),
  has_expiry: z.boolean().default(true),
  expiry_warning_days: z.number().int().min(0).max(365).default(30),
})

export const complianceDocTypeUpdateSchema = complianceDocTypeInputSchema.partial()

// Requirement schemas
export const complianceRequirementInputSchema = z.object({
  document_type_id: z.string().uuid(),
  is_required: z.boolean().default(true),
  min_coverage_cents: z.number().int().positive().optional(),
  requires_additional_insured: z.boolean().default(false),
  requires_primary_noncontributory: z.boolean().default(false),
  requires_waiver_of_subrogation: z.boolean().default(false),
  notes: z.string().max(1000).optional(),
})

export const setCompanyRequirementsSchema = z.object({
  company_id: z.string().uuid(),
  requirements: z.array(complianceRequirementInputSchema),
})

// Document upload schemas
export const complianceDocumentStatusEnum = z.enum(["pending_review", "approved", "rejected", "expired"]) satisfies z.ZodType<ComplianceDocumentStatus>

export const complianceDocumentUploadSchema = z.object({
  document_type_id: z.string().uuid(),
  effective_date: z.string().optional(),
  expiry_date: z.string().optional(),
  policy_number: z.string().max(100).optional(),
  coverage_amount_cents: z.number().int().positive().optional(),
  carrier_name: z.string().max(200).optional(),
  additional_insured: z.boolean().optional(),
  primary_noncontributory: z.boolean().optional(),
  waiver_of_subrogation: z.boolean().optional(),
})

// Review schemas
export const complianceReviewDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().max(1000).optional(),
  rejection_reason: z.string().max(1000).optional(),
})

// Filter schemas
export const complianceDocumentFiltersSchema = z.object({
  company_id: z.string().uuid().optional(),
  status: complianceDocumentStatusEnum.optional(),
  document_type_id: z.string().uuid().optional(),
}).optional()

// Types
export type ComplianceDocTypeInput = z.infer<typeof complianceDocTypeInputSchema>
export type ComplianceDocTypeUpdateInput = z.infer<typeof complianceDocTypeUpdateSchema>
export type ComplianceRequirementInput = z.infer<typeof complianceRequirementInputSchema>
export type SetCompanyRequirementsInput = z.infer<typeof setCompanyRequirementsSchema>
export type ComplianceDocumentUploadInput = z.infer<typeof complianceDocumentUploadSchema>
export type ComplianceReviewDecision = z.infer<typeof complianceReviewDecisionSchema>
export type ComplianceDocumentFilters = z.infer<typeof complianceDocumentFiltersSchema>
