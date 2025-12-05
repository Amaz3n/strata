"use server"

import { approveChangeOrderFromPortal, getChangeOrderForPortal } from "@/lib/services/change-orders"
import { validatePortalToken } from "@/lib/services/portal-access"

export async function approveChangeOrderAction(input: { token: string; changeOrderId: string; signature?: string | null; name?: string }) {
  const access = await validatePortalToken(input.token)
  if (!access) {
    throw new Error("Invalid or expired link")
  }

  const changeOrder = await getChangeOrderForPortal(input.changeOrderId, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    throw new Error("Change order not available")
  }

  await approveChangeOrderFromPortal({
    changeOrderId: input.changeOrderId,
    tokenId: access.id,
    signatureData: input.signature,
    signatureIp: null,
    signerName: input.name,
  })

  return { success: true }
}

