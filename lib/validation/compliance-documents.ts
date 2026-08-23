import { z } from "zod"

import type { ComplianceDocumentKind, ComplianceDocumentStatus } from "@/lib/types"

export const complianceDocumentKindEnum = z.enum([
  "insurance",
  "tax",
  "license",
  "safety",
  "other",
]) satisfies z.ZodType<ComplianceDocumentKind>

// Document type schemas
export const complianceDocTypeInputSchema = z.object({
  name: z.string().min(2, "Name is required"),
  code: z.string().min(2, "Code is required").regex(/^[a-z0-9_]+$/, "Code must be lowercase alphanumeric with underscores"),
  kind: complianceDocumentKindEnum.default("other"),
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

/**
 * A project overlay row. `company_id` null means the rule applies to every
 * vendor on the project; naming a company narrows it to that vendor's work on
 * that job.
 */
export const projectComplianceRequirementInputSchema = complianceRequirementInputSchema.extend({
  company_id: z.string().uuid().nullable().optional(),
})

export const setProjectRequirementsSchema = z.object({
  project_id: z.string().uuid(),
  requirements: z.array(projectComplianceRequirementInputSchema),
})

export const complianceRequirementWaiverInputSchema = z.object({
  document_type_id: z.string().uuid(),
  reason: z.string().max(1000).optional(),
  expires_at: z.string().optional(),
})

export const complianceRequirementWaiverRevokeSchema = z.object({
  reason: z.string().max(1000).optional(),
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
  license_number: z.string().max(100).optional(),
  license_jurisdiction: z.string().max(120).optional(),
  license_classification: z.string().max(120).optional(),
})

// Review schemas
export const complianceReviewDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().max(1000).optional(),
  rejection_reason: z.string().max(1000).optional(),
  /**
   * Corrections the reviewer made to the document's own facts while deciding.
   * The reviewer is the authority on what the certificate says; extraction only
   * proposes.
   */
  corrections: complianceDocumentUploadSchema.partial().omit({ document_type_id: true }).optional(),
})

/**
 * Withdrawing a decision already made. Requires a reason because the document
 * may have released money before it was pulled back.
 */
export const complianceRevokeDecisionSchema = z.object({
  reason: z.string().trim().min(8, "Say why the decision is being withdrawn").max(1000),
})

/** A builder asking a vendor for the documents that are outstanding. */
export const complianceDocumentRequestSchema = z.object({
  document_type_ids: z.array(z.string().uuid()).min(1, "Pick at least one document"),
  message: z.string().max(2000).optional(),
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
export type ProjectComplianceRequirementInput = z.infer<typeof projectComplianceRequirementInputSchema>
export type SetProjectRequirementsInput = z.infer<typeof setProjectRequirementsSchema>
export type ComplianceRequirementWaiverInput = z.infer<typeof complianceRequirementWaiverInputSchema>
export type ComplianceRequirementWaiverRevokeInput = z.infer<typeof complianceRequirementWaiverRevokeSchema>
export type ComplianceDocumentUploadInput = z.infer<typeof complianceDocumentUploadSchema>
export type ComplianceReviewDecision = z.infer<typeof complianceReviewDecisionSchema>
export type ComplianceRevokeDecisionInput = z.infer<typeof complianceRevokeDecisionSchema>
export type ComplianceDocumentRequestInput = z.infer<typeof complianceDocumentRequestSchema>
export type ComplianceDocumentFilters = z.infer<typeof complianceDocumentFiltersSchema>
