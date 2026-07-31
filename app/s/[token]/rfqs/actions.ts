"use server"

import { recordPortalChangeEventRfqResponse } from "@/lib/services/change-events"

export async function submitRfqResponse(token: string, input: { amount_cents: number; notes?: string; declined: boolean }) {
  try { return { success: true as const, data: await recordPortalChangeEventRfqResponse(token, input) } }
  catch (error) { return { success: false as const, error: error instanceof Error ? error.message : "Could not submit response." } }
}
