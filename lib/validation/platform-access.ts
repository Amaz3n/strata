import { z } from "zod"

/** Support access to a customer's organization never outlasts a working day. */
export const PLATFORM_ACCESS_MAX_MINUTES = 8 * 60
export const PLATFORM_ACCESS_DEFAULT_MINUTES = 60

/** The choices the enter-organization dialog offers, in minutes. */
export const PLATFORM_ACCESS_DURATIONS = [30, 60, 120, 240, 480] as const

export const platformAccessReasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters")
  .max(500, "Keep the reason under 500 characters")

export const enterPlatformOrgSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  reason: platformAccessReasonSchema,
  durationMinutes: z.coerce
    .number()
    .int()
    .min(5, "Support access lasts at least 5 minutes")
    .max(PLATFORM_ACCESS_MAX_MINUTES, "Support access cannot last longer than 8 hours")
    .default(PLATFORM_ACCESS_DEFAULT_MINUTES),
})
export type EnterPlatformOrgInput = z.input<typeof enterPlatformOrgSchema>

export const revokePlatformAccessGrantSchema = z.object({
  grantId: z.string().uuid("Invalid support access id"),
})
export type RevokePlatformAccessGrantInput = z.infer<typeof revokePlatformAccessGrantSchema>
