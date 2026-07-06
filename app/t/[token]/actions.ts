"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { signTmTicketByToken } from "@/lib/services/tm-tickets"

export async function signTmTicketFormAction(token: string, formData: FormData) {
  const headerStore = await headers()
  const forwarded = headerStore.get("x-forwarded-for")
  const signerIp = forwarded?.split(",")?.[0]?.trim() ?? headerStore.get("x-real-ip")
  const userAgent = headerStore.get("user-agent")
  const signerName = String(formData.get("signer_name") || "").trim()
  const signerEmail = String(formData.get("signer_email") || "").trim() || null
  if (formData.get("accepted") !== "on") {
    throw new Error("Please approve the T&M ticket before signing.")
  }

  await signTmTicketByToken({
    token,
    signerName,
    signerEmail,
    signerIp,
    signatureData: {
      typed_signature: signerName,
      accepted_at: new Date().toISOString(),
      user_agent: userAgent,
    },
  })

  redirect(`/t/${token}?signed=1`)
}
