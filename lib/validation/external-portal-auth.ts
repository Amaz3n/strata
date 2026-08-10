import { z } from "zod"

export const externalPortalTokenTypeSchema = z.enum(["portal", "bid"])

/**
 * No claim-vs-login mode: the server decides from whether an identity exists for
 * the invited email. `full_name` is only read when an account is actually created.
 */
export const authenticateExternalPortalAccountSchema = z.object({
  token: z.string().trim().min(1),
  token_type: externalPortalTokenTypeSchema,
  email: z.string().trim().email(),
  full_name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

export type AuthenticateExternalPortalAccountInput = z.infer<typeof authenticateExternalPortalAccountSchema>
