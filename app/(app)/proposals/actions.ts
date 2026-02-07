"use server"

import { revalidatePath } from "next/cache"
import type { Proposal } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { createProposal, sendProposal, generateProposalLink } from "@/lib/services/proposals"
import type { ProposalInput } from "@/lib/validation/proposals"

type ProposalESignStatus = "not_prepared" | "draft" | "sent" | "signed" | "voided" | "expired"

const proposalESignStatusPriority: Record<ProposalESignStatus, number> = {
  not_prepared: 0,
  expired: 1,
  voided: 2,
  draft: 3,
  sent: 4,
  signed: 5,
}

export async function listProposalsAction(): Promise<
  Array<Proposal & { project_name?: string | null; esign_status?: ProposalESignStatus | null; esign_document_id?: string | null }>
> {
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

  const proposals = (data ?? []) as any[]
  const projectIds = Array.from(
    new Set(
      proposals
        .map((row) => row.project_id as string | null | undefined)
        .filter((projectId): projectId is string => !!projectId),
    ),
  )

  const documentsByProposalId = new Map<string, { id: string; status: ProposalESignStatus; created_at?: string | null }>()
  if (projectIds.length > 0) {
    const { data: documents, error: docsError } = await supabase
      .from("documents")
      .select("id, project_id, status, metadata, created_at")
      .eq("org_id", orgId)
      .eq("document_type", "proposal")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false })

    if (!docsError && documents) {
      for (const document of documents as any[]) {
        const proposalId = document.metadata?.proposal_id as string | undefined
        if (!proposalId) continue
        const status = (document.status ?? "draft") as ProposalESignStatus
        const current = documentsByProposalId.get(proposalId)
        if (!current) {
          documentsByProposalId.set(proposalId, { id: document.id, status, created_at: document.created_at })
          continue
        }

        const nextPriority = proposalESignStatusPriority[status] ?? 0
        const currentPriority = proposalESignStatusPriority[current.status] ?? 0
        const shouldReplace =
          nextPriority > currentPriority ||
          (nextPriority === currentPriority &&
            new Date(document.created_at ?? 0).getTime() > new Date(current.created_at ?? 0).getTime())

        if (shouldReplace) {
          documentsByProposalId.set(proposalId, { id: document.id, status, created_at: document.created_at })
        }
      }
    }
  }

  return proposals.map((row: any) => {
    const linkedDocument = documentsByProposalId.get(row.id)
    return {
      ...(row as Proposal),
      project_name: row.project?.name ?? null,
      esign_status: linkedDocument?.status ?? "not_prepared",
      esign_document_id: linkedDocument?.id ?? null,
    }
  })
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
  const { viewUrl, proposal, token } = await createProposal({
    ...input,
    lines: input.lines.map((l) => ({ ...l, is_optional: l.is_optional ?? false })),
  })
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
