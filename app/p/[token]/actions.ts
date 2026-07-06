"use server"

import { markPortalPinVerified, validatePortalPin, validatePortalToken } from "@/lib/services/portal-access"
import { portalPinSchema } from "@/lib/validation/portal-access"

export async function verifyPortalPinAction({
  token,
  pin,
}: {
  token: string
  pin: string
}) {
  const parsed = portalPinSchema.safeParse(pin)
  if (!parsed.success) {
    return { valid: false }
  }

  const access = await validatePortalToken(token)
  if (!access) {
    return { valid: false }
  }

  const result = await validatePortalPin({ token, pin: parsed.data })
  if (result.valid) {
    await markPortalPinVerified(token)
  }
  return result
}
