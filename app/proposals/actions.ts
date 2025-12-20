"use server"

import { revalidatePath } from "next/cache"
import type { Proposal } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { createProposal, sendProposal, generateProposalLink } from "@/lib/services/proposals"
import type { ProposalInput } from "@/lib/validation/proposals"

export async function listProposalsAction(): Promise<Array<Proposal & { project_name?: string | null }>> {
  const { supabase, orgId } = await requireOrgContext()
  const { data, error } = await supabase
    .from("proposals")
    .select("*, project:projects(id, name)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list proposals", error.message)
    return []
  }

  return (data ?? []).map((row: any) => ({
    ...(row as Proposal),
    project_name: row.project?.name ?? null,
  }))
}

export async function listProposalProjectsAction() {
  const { supabase, orgId } = await requireOrgContext()
  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list projects for proposals", error.message)
    return []
  }

  return data ?? []
}

export async function createProposalAction(input: ProposalInput) {
  const { viewUrl, proposal, token } = await createProposal(input)
  revalidatePath("/proposals")
  return { viewUrl, proposal: { ...proposal, token }, token }
}

export async function sendProposalAction(proposalId: string) {
  const proposal = await sendProposal(proposalId)
  revalidatePath("/proposals")
  return proposal
}

export async function generateProposalLinkAction(proposalId: string) {
  const result = await generateProposalLink(proposalId)
  revalidatePath("/proposals")
  return result
}
