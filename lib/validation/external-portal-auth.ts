import { z } from "zod"

export const externalPortalTokenTypeSchema = z.enum(["portal", "bid"])

export const authenticateExternalPortalAccountSchema = z.object({
  token: z.string().trim().min(1),
  token_type: externalPortalTokenTypeSchema,
  mode: z.enum(["claim", "login"]),
  email: z.string().trim().email(),
  full_name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

export const setExternalPortalAccountStatusSchema = z.object({
  account_id: z.string().uuid(),
  project_id: z.string().uuid(),
  status: z.enum(["active", "paused", "revoked"]),
})

export type AuthenticateExternalPortalAccountInput = z.infer<typeof authenticateExternalPortalAccountSchema>
export type SetExternalPortalAccountStatusInput = z.infer<typeof setExternalPortalAccountStatusSchema>
