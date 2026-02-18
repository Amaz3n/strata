"use server"

import {
  authenticateExternalPortalAccountWithToken,
  signOutExternalPortalAccount,
} from "@/lib/services/external-portal-auth"
import { authenticateExternalPortalAccountSchema } from "@/lib/validation/external-portal-auth"

export async function authenticateExternalPortalAccountAction(input: unknown) {
  const parsed = authenticateExternalPortalAccountSchema.parse(input)
  await authenticateExternalPortalAccountWithToken({
    token: parsed.token,
    tokenType: parsed.token_type,
    mode: parsed.mode,
    email: parsed.email,
    fullName: parsed.full_name,
    password: parsed.password,
  })
  return { success: true }
}

export async function signOutExternalPortalAccountAction() {
  await signOutExternalPortalAccount()
  return { success: true }
}
