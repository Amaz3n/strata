import { z } from "zod"

export const accountingConnectionLabelSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
})

const optionalReferenceId = z.string().trim().min(1).max(255).nullable().optional()

export const accountingConnectionSettingsSchema = z.object({
  connectionId: z.string().uuid(),
  settings: z.object({
    auto_sync: z.boolean().optional(),
    sync_payments: z.boolean().optional(),
    customer_sync_mode: z.enum(["create_new", "match_existing"]).optional(),
    default_income_account_id: optionalReferenceId,
    default_expense_account_id: optionalReferenceId,
    default_payment_account_id: optionalReferenceId,
    default_credit_card_account_id: optionalReferenceId,
    default_ap_account_id: optionalReferenceId,
    project_mapping_mode: z.enum(["customer", "sub_customer"]).optional(),
    invoice_number_sync: z.boolean().optional(),
  }).strict(),
})

const dimensionValueSchema = z.object({ id: z.string().min(1).max(255), name: z.string().max(255).nullable().transform((name) => name ?? "") })

export const accountingEntityMapSchema = z.object({
  id: z.string().uuid().optional(),
  connectionId: z.string().uuid(),
  divisionId: z.string().uuid().nullable().optional(),
  communityId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dimensions: z.record(z.enum(["class", "customer", "location", "department", "entity"]), dimensionValueSchema),
  acknowledgeResync: z.boolean().optional(),
})
