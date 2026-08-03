"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import { startVendorPayoutSetup } from "@/lib/services/payment-rail-setup"

export async function startVendorPayoutSetupAction(input: {
  portal_token: string
  vendor_entity_id?: string
  legal_name?: string
  dba_name?: string
  return_path: string
}): Promise<ActionResult<{ url: string | null }>> {
  try {
    const result = await startVendorPayoutSetup(input)
    return { success: true, data: { url: result.url } }
  } catch (error) {
    return actionError(error)
  }
}
