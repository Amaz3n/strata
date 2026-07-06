import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"

const registerSchema = z.object({
  token: z.string().trim().min(16).max(400),
  platform: z.string().trim().max(20).optional(),
  app_version: z.string().trim().max(40).optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
})

export async function registerMobileDevice(context: MobileOrgContext, input: unknown): Promise<{ registered: boolean }> {
  const parsed = registerSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_device", "A valid device token is required.")

  const { error } = await context.serviceSupabase.from("device_tokens").upsert(
    {
      org_id: context.orgId,
      user_id: context.user.id,
      token: parsed.data.token,
      platform: parsed.data.platform ?? "ios",
      app_version: parsed.data.app_version ?? null,
      environment: parsed.data.environment ?? "production",
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "token" },
  )
  if (error) throw new MobileAPIError(500, "device_register_failed", "The device could not be registered for push.")
  return { registered: true }
}

const unregisterSchema = z.object({ token: z.string().trim().min(16).max(400) })

export async function unregisterMobileDevice(context: MobileOrgContext, input: unknown): Promise<{ unregistered: boolean }> {
  const parsed = unregisterSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_device", "A valid device token is required.")
  const { error } = await context.serviceSupabase
    .from("device_tokens")
    .delete()
    .eq("user_id", context.user.id)
    .eq("token", parsed.data.token)
  if (error) throw new MobileAPIError(500, "device_unregister_failed", "The device could not be unregistered.")
  return { unregistered: true }
}
