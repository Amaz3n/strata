import { createHmac, randomBytes } from "crypto"
import { NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

interface RouteParams {
  params: { token: string }
}

function requireProposalSecret() {
  const secret = process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing PROPOSAL_SECRET environment variable")
  }
  return secret
}

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
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
  return (
    ordered.find(
      (request) =>
        request.required !== false &&
        request.status !== "signed" &&
        request.status !== "voided" &&
        request.status !== "expired",
    ) ?? null
  )
}

function buildSigningUrl(rawToken: string, request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) return `${appUrl}/d/${rawToken}`
  const url = new URL(request.url)
  return `${url.origin}/d/${rawToken}`
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { token } = params
    const proposalTokenHash = createHmac("sha256", requireProposalSecret()).update(token).digest("hex")

    const supabase = createServiceSupabaseClient()

    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, org_id, status, valid_until, recipient:contacts(email)")
      .eq("token_hash", proposalTokenHash)
      .maybeSingle()

    if (!proposal || proposal.status === "accepted") {
      return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
    }

    if (proposal.valid_until && new Date(proposal.valid_until) < new Date()) {
      return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
    }

    const { data: proposalDocument } = await supabase
      .from("documents")
      .select("id, status")
      .eq("org_id", proposal.org_id)
      .eq("source_entity_type", "proposal")
      .eq("source_entity_id", proposal.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!proposalDocument?.id || proposalDocument.status === "signed") {
      return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
    }

    const { data: signingRequests } = await supabase
      .from("document_signing_requests")
      .select("id, status, required, sequence, sent_to_email")
      .eq("org_id", proposal.org_id)
      .eq("document_id", proposalDocument.id)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    const nextRequest = pickNextRequiredRequest(signingRequests ?? [])
    if (!nextRequest?.id) {
      return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
    }

    const recipientEmail = proposal.recipient?.[0]?.email?.trim()?.toLowerCase() ?? null
    const nextSignerEmail = nextRequest.sent_to_email?.trim()?.toLowerCase() ?? null
    const isIntendedRecipient = !recipientEmail || !nextSignerEmail || recipientEmail === nextSignerEmail
    if (!isIntendedRecipient) {
      return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
    }

    const rawSigningToken = randomBytes(32).toString("hex")
    const signingTokenHash = createHmac("sha256", requireDocumentSigningSecret())
      .update(rawSigningToken)
      .digest("hex")

    const { error: updateError } = await supabase
      .from("document_signing_requests")
      .update({
        token_hash: signingTokenHash,
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .eq("org_id", proposal.org_id)
      .eq("id", nextRequest.id)

    if (updateError) {
      throw new Error(`Failed to issue signing request: ${updateError.message}`)
    }

    return NextResponse.redirect(buildSigningUrl(rawSigningToken, request))
  } catch (error) {
    console.error("Failed to continue proposal signing", error)
    const { token } = params
    return NextResponse.redirect(new URL(`/proposal/${token}`, request.url))
  }
}
