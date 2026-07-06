import { z } from "zod"

const dateInput = z.coerce.date()

export const costCategorySchema = z.enum(["labor", "material", "subcontract", "equipment", "overhead", "other"])

export const timeEntryInputSchema = z.object({
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid().optional().nullable(),
  workerUserId: z.string().uuid().optional().nullable(),
  workerCompanyId: z.string().uuid().optional().nullable(),
  workerName: z.string().min(1).optional().nullable(),
  workDate: dateInput,
  hours: z.number().positive().max(24),
  baseRateCents: z.number().int().min(0).default(0),
  burdenMultiplier: z.number().min(1).default(1),
  isBillable: z.boolean().default(true),
  isOvertime: z.boolean().default(false),
  otMultiplier: z.number().min(1).max(4).default(1.5),
  isDoubleTime: z.boolean().default(false),
  dtMultiplier: z.number().min(1).max(4).default(2),
  notes: z.string().max(2000).optional().nullable(),
  attachedFileIds: z.array(z.string().uuid()).default([]),
})

export const timeEntryUpdateSchema = z.object({
  costCodeId: z.string().uuid().optional().nullable(),
  baseRateCents: z.number().int().min(0).optional(),
  burdenMultiplier: z.number().min(1).optional(),
  isBillable: z.boolean().optional(),
  isOvertime: z.boolean().optional(),
  otMultiplier: z.number().min(1).max(4).optional(),
  isDoubleTime: z.boolean().optional(),
  dtMultiplier: z.number().min(1).max(4).optional(),
  workerName: z.string().min(1).optional(),
  notes: z.string().max(2000).optional().nullable(),
})

export const projectExpenseInputSchema = z.object({
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid().optional().nullable(),
  vendorCompanyId: z.string().uuid().optional().nullable(),
  vendorNameText: z.string().max(255).optional().nullable(),
  expenseDate: dateInput,
  description: z.string().max(1000).optional().nullable(),
  amountCents: z.number().int().min(0),
  taxCents: z.number().int().min(0).default(0),
  paymentMethod: z.enum(["cash", "credit_card", "check", "ach", "company_card", "reimbursable_personal", "other"]).optional().nullable(),
  receiptFileId: z.string().uuid().optional().nullable(),
  isBillable: z.boolean().default(true),
  markupPercentOverride: z.number().min(0).max(200).optional().nullable(),
  qboTransactionType: z.enum(["purchase", "bill"]).optional().nullable(),
  qboExpenseAccountId: z.string().max(80).optional().nullable(),
  qboExpenseAccountName: z.string().max(255).optional().nullable(),
  qboPaymentAccountId: z.string().max(80).optional().nullable(),
  qboPaymentAccountName: z.string().max(255).optional().nullable(),
  qboApAccountId: z.string().max(80).optional().nullable(),
  qboApAccountName: z.string().max(255).optional().nullable(),
  qboVendorId: z.string().max(80).optional().nullable(),
  qboVendorName: z.string().max(255).optional().nullable(),
})

export const markupRuleInputSchema = z.object({
  scope: z.enum(["org", "contract", "cost_code"]),
  contractId: z.string().uuid().optional().nullable(),
  costCodeId: z.string().uuid().optional().nullable(),
  markupPercent: z.number().min(0).max(200),
  appliesToCategory: z.string().max(80).optional().nullable(),
  effectiveFrom: dateInput.optional().nullable(),
  effectiveTo: dateInput.optional().nullable(),
})

export const generateInvoiceFromCostsInputSchema = z.object({
  projectId: z.string().uuid(),
  billingPeriodId: z.string().uuid().optional().nullable(),
  dateRange: z.object({
    from: dateInput,
    to: dateInput,
  }),
  billableCostIds: z.array(z.string().uuid()).optional(),
  costCodeIds: z.array(z.string().uuid()).optional(),
  groupBy: z.enum(["cost_code", "detail"]).default("cost_code"),
  includeAllowanceVariances: z.boolean().default(false),
  includeEarnedFee: z.boolean().default(false),
  overrideGmpCap: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200).optional(),
})

export const approvalDecisionSchema = z.object({
  rejectionReason: z.string().max(1000).optional().nullable(),
})

export type TimeEntryInput = z.infer<typeof timeEntryInputSchema>
export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>
export type ProjectExpenseInput = z.infer<typeof projectExpenseInputSchema>
export type MarkupRuleInput = z.infer<typeof markupRuleInputSchema>
export type GenerateInvoiceFromCostsInput = z.infer<typeof generateInvoiceFromCostsInputSchema>
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>
