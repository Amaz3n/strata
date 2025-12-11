import { createHmac } from "crypto"
import { notFound } from "next/navigation"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ProposalViewClient } from "./proposal-view-client"

export const revalidate = 0

interface Params {
  params: Promise<{ token: string }>
}

export default async function ProposalPage({ params }: Params) {
  const { token } = await params
  const secret = process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing PROPOSAL_SECRET environment variable")
  }

  const tokenHash = createHmac("sha256", secret).update(token).digest("hex")
  const supabase = createServiceSupabaseClient()

  const { data: proposal } = await supabase
    .from("proposals")
    .select(
      `
        *,
        lines:proposal_lines(* order by sort_order),
        project:projects(name, address),
        org:orgs(name, logo_url),
        recipient:contacts(full_name, email)
      `,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

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

  return <ProposalViewClient proposal={proposal as any} token={token} />
}


