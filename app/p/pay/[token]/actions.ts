"use server"

import { createPayLinkPaymentIntent } from "@/lib/services/payments"

export async function createPayLinkPaymentIntentAction(token: string) {
  const intent = await createPayLinkPaymentIntent(token)
  return {
    clientSecret: intent.client_secret ?? "",
    connectedAccountId: intent.connected_account_id ?? null,
  }
}
