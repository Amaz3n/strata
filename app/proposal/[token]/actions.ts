"use server"

import { headers } from "next/headers"

import { acceptProposal } from "@/lib/services/proposals"

export async function acceptProposalAction(input: { token: string; signature?: string | null; signerName: string }) {
  if (!input.token) {
    throw new Error("Missing proposal token")
  }

  const signerName = input.signerName?.trim()
  if (!signerName) {
    throw new Error("Signer name is required")
  }

  const signaturePayload = input.signature ?? null
  const forwardedFor = headers().get("x-forwarded-for")
  const signerIp = forwardedFor?.split(",")?.[0]?.trim() ?? undefined

  await acceptProposal(input.token, {
    signature_svg: signaturePayload,
    signer_name: signerName,
    signer_ip: signerIp,
  })

  return { success: true }
}

