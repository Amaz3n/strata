"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import { resendExternalIdentityVerification } from "@/lib/services/external-portal-auth"
import { startVendorPayoutSetup } from "@/lib/services/payment-rail-setup"
import {
  decideVendorEntityJoinRequest,
  inviteVendorEntityAdministrator,
  removeVendorEntityMember,
  respondToVendorEntityInvitation,
} from "@/lib/services/vendor-payment-identities"

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

/**
 * Payout setup is gated on a confirmed email address, so the vendor needs a way
 * to get another confirmation link without leaving the page that is blocking
 * them.
 */
export async function resendVendorEmailVerificationAction(): Promise<ActionResult<{ sent: boolean; alreadyVerified: boolean }>> {
  try {
    return { success: true, data: await resendExternalIdentityVerification() }
  } catch (error) {
    return actionError(error)
  }
}

export async function inviteVendorEntityAdministratorAction(input: {
  vendor_entity_id: string
  email: string
}): Promise<ActionResult<{ message: string }>> {
  try {
    const result = await inviteVendorEntityAdministrator(input)
    return { success: true, data: { message: result.message } }
  } catch (error) {
    return actionError(error)
  }
}

export async function respondToVendorEntityInvitationAction(input: {
  membership_id: string
  accept: boolean
}): Promise<ActionResult<{ accepted: boolean }>> {
  try {
    return { success: true, data: await respondToVendorEntityInvitation(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function decideVendorEntityJoinRequestAction(input: {
  membership_id: string
  approve: boolean
}): Promise<ActionResult<{ approved: boolean }>> {
  try {
    return { success: true, data: await decideVendorEntityJoinRequest(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function removeVendorEntityMemberAction(input: {
  membership_id: string
}): Promise<ActionResult<{ removed: boolean }>> {
  try {
    return { success: true, data: await removeVendorEntityMember(input) }
  } catch (error) {
    return actionError(error)
  }
}
