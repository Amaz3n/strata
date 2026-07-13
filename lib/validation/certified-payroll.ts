import { z } from "zod"

const cents = z.number().int().min(0).max(100_000_000)

export const wageDeterminationInputSchema = z.object({
  project_id: z.string().uuid(),
  determination_number: z.string().trim().min(1).max(80),
  source: z.string().trim().max(500).optional().nullable(),
  effective_date: z.string().date().optional().nullable(),
})

export const wageClassificationInputSchema = z.object({
  determination_id: z.string().uuid(),
  classification: z.string().trim().min(1).max(200),
  base_rate_cents: cents,
  fringe_rate_cents: cents.default(0),
})

export const workerProfileInputSchema = z.object({
  user_id: z.string().uuid().optional().nullable(),
  display_name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(1000).optional().nullable(),
  tax_id_last4: z.string().trim().regex(/^\d{4}$/, "Enter exactly the last four digits").optional().nullable(),
  default_classification_id: z.string().uuid().optional().nullable(),
  fringe_paid_in_cash: z.boolean().default(false),
})

export const createCertifiedPayrollSchema = z.object({
  project_id: z.string().uuid(),
  week_ending: z.string().date(),
  is_no_work: z.boolean().default(false),
  is_final: z.boolean().default(false),
})

export const certifiedPayrollLineUpdateSchema = z.object({
  classification_id: z.string().uuid().optional().nullable(),
  gross_all_projects_cents: cents.optional().nullable(),
  deductions: z.record(z.string(), cents).optional().nullable(),
  net_pay_cents: cents.optional().nullable(),
})

export type WageDeterminationInput = z.infer<typeof wageDeterminationInputSchema>
export type WageClassificationInput = z.infer<typeof wageClassificationInputSchema>
export type WorkerProfileInput = z.infer<typeof workerProfileInputSchema>
export type CreateCertifiedPayrollInput = z.infer<typeof createCertifiedPayrollSchema>
export type CertifiedPayrollLineUpdate = z.infer<typeof certifiedPayrollLineUpdateSchema>
