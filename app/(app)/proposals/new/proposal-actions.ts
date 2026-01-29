"use server"

import { revalidatePath } from "next/cache"

import { createProposal } from "@/lib/services/proposals"
import type { ProposalInput } from "@/lib/validation/proposals"

export async function createProposalAction(input: ProposalInput) {
  const { viewUrl, proposal } = await createProposal({
    ...input,
    lines: input.lines.map((l) => ({ ...l, is_optional: l.is_optional ?? false })),
  })
  revalidatePath("/proposals")
  return { viewUrl, proposal }
}
