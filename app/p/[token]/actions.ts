"use server"

import { validatePortalPin } from "@/lib/services/portal-access"

export async function verifyPortalPinAction({
  token,
  pin,
}: {
  token: string
  pin: string
}) {
  return validatePortalPin({ token, pin })
}
