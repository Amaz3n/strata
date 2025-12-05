import { z } from "zod"

export const portalPermissionsSchema = z.object({
  can_view_schedule: z.boolean().default(true),
  can_view_photos: z.boolean().default(true),
  can_view_documents: z.boolean().default(true),
  can_download_files: z.boolean().default(true),
  can_view_daily_logs: z.boolean().default(false),
  can_view_budget: z.boolean().default(false),
  can_approve_change_orders: z.boolean().default(true),
  can_submit_selections: z.boolean().default(true),
  can_create_punch_items: z.boolean().default(false),
  can_message: z.boolean().default(true),
  can_view_invoices: z.boolean().default(true),
  can_pay_invoices: z.boolean().default(false),
  can_view_rfis: z.boolean().default(true),
  can_view_submittals: z.boolean().default(true),
  can_respond_rfis: z.boolean().default(true),
  can_submit_submittals: z.boolean().default(true),
})

export const createPortalTokenInputSchema = z.object({
  project_id: z.string().uuid(),
  portal_type: z.enum(["client", "sub"]),
  contact_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  expires_at: z.string().optional().nullable(),
  permissions: portalPermissionsSchema.partial().optional(),
})

export const revokePortalTokenInputSchema = z.object({
  token_id: z.string().uuid(),
  project_id: z.string().uuid(),
})

export type CreatePortalTokenInput = z.infer<typeof createPortalTokenInputSchema>
export type RevokePortalTokenInput = z.infer<typeof revokePortalTokenInputSchema>

