import { z } from "zod"

/** Settings whose behavior is implemented by the shared delivery policy. */
export const accountingCommonSettingsUpdateSchema = z
  .object({
    auto_sync: z.boolean().optional(),
    sync_invoices: z.boolean().optional(),
    sync_payments: z.boolean().optional(),
  })
  .strict()
export type AccountingCommonSettingsUpdate = z.infer<typeof accountingCommonSettingsUpdateSchema>
