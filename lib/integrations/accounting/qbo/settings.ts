import { z } from "zod"
import { accountingCommonSettingsUpdateSchema } from "@/lib/integrations/accounting/settings"

const referenceId = z.string().trim().min(1).max(255).nullable().optional()
const item = z.object({ id: z.string().trim().min(1).max(255), name: z.string().max(255).nullable().optional() }).strict()
export const qboConnectionSettingsUpdateSchema = accountingCommonSettingsUpdateSchema
  .extend({
    customer_sync_mode: z.enum(["create_new", "match_existing"]).optional(),
    default_income_account_id: referenceId,
    default_expense_account_id: referenceId,
    default_payment_account_id: referenceId,
    default_credit_card_account_id: referenceId,
    default_ap_account_id: referenceId,
    default_invoice_item: item.nullable().optional(),
    invoice_item_mappings: z.record(z.string().min(1), item).optional(),
    project_mapping_mode: z.enum(["customer", "sub_customer"]).optional(),
    invoice_number_sync: z.boolean().optional(),
  })
  .strict()
