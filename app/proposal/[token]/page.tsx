import { createHmac } from "crypto"
import { notFound } from "next/navigation"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ProposalViewClient } from "./proposal-view-client"

export const revalidate = 0

interface Params {
  params: Promise<{ token: string }>
}

function requireProposalSecret() {
  const secret = process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing PROPOSAL_SECRET environment variable")
  }
  return secret
}

function pickNextRequiredRequest(
  requests: Array<{
    id: string
    status?: string | null
    required?: boolean | null
    sequence?: number | null
    sent_to_email?: string | null
  }>,
) {
  const ordered = [...requests].sort((a, b) => (a.sequence ?? 1) - (b.sequence ?? 1))
  const nextRequired = ordered.find(
    (request) =>
      request.required !== false &&
      request.status !== "signed" &&
      request.status !== "voided" &&
      request.status !== "expired",
  )
  if (!nextRequired?.id) return null
  return nextRequired
}

export default async function ProposalPage({ params }: Params) {
  const { token } = await params
  const tokenHash = createHmac("sha256", requireProposalSecret()).update(token).digest("hex")
  const supabase = createServiceSupabaseClient()

  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select(
      `
        *,
        lines:proposal_lines(*),
        project:projects(name, location),
        org:orgs(name),
        recipient:contacts(full_name, email)
      `,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (proposalError) {
    throw new Error(`Database error: ${proposalError.message}`)
  }

  if (!proposal) {
    notFound()
  }

  if (!proposal.viewed_at) {
    await supabase.from("proposals").update({ viewed_at: new Date().toISOString() }).eq("id", proposal.id)
  }

  if (proposal.status === "accepted") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
        <div className="text-center">
          <div className="mb-4 text-6xl">✓</div>
          <h1 className="text-2xl font-bold text-green-600">Proposal Accepted</h1>
          <p className="mt-2 text-gray-600">Thank you! Your contract has been generated.</p>
        </div>
      </div>
    )
  }

  if (proposal.valid_until && new Date(proposal.valid_until) < new Date()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
        <div className="text-center">
          <div className="mb-4 text-6xl">⏰</div>
          <h1 className="text-2xl font-bold text-orange-600">Proposal Expired</h1>
          <p className="mt-2 text-gray-600">
            This proposal expired on {new Date(proposal.valid_until).toLocaleDateString()}.
            <br />
            Please contact us for an updated proposal.
          </p>
        </div>
      </div>
    )
  }

  let canContinueSigning = false

  const { data: proposalDocument } = await supabase
    .from("documents")
    .select("id, status")
    .eq("org_id", proposal.org_id)
    .eq("source_entity_type", "proposal")
    .eq("source_entity_id", proposal.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (proposalDocument?.id && proposalDocument.status !== "signed") {
    const { data: signingRequests } = await supabase
      .from("document_signing_requests")
      .select("id, status, required, sequence, sent_to_email")
      .eq("org_id", proposal.org_id)
      .eq("document_id", proposalDocument.id)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    const nextRequired = pickNextRequiredRequest(signingRequests ?? [])

    const recipientEmail = proposal.recipient?.email?.trim()?.toLowerCase() ?? null
    const nextSignerEmail = nextRequired?.sent_to_email?.trim()?.toLowerCase() ?? null
    const isIntendedRecipient = !recipientEmail || !nextSignerEmail || recipientEmail === nextSignerEmail

    canContinueSigning = !!nextRequired?.id && isIntendedRecipient
  }

  return (
    <ProposalViewClient
      proposal={proposal as any}
      continueSigningUrl={canContinueSigning ? `/proposal/${token}/continue` : null}
    />
  )
}
