import { createHmac, randomBytes } from "crypto"
import { NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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

async function findSubcontractDocument({
  orgId,
  projectId,
  commitmentId,
  sourceDocumentId,
}: {
  orgId: string
  projectId: string
  commitmentId: string
  sourceDocumentId?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  if (sourceDocumentId) {
    const { data: document } = await supabase
      .from("documents")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", sourceDocumentId)
      .maybeSingle()
    if (document?.id) return document
  }

  const { data: sourcedDocument } = await supabase
    .from("documents")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("source_entity_type", "subcontract")
    .eq("source_entity_id", commitmentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sourcedDocument?.id) return sourcedDocument

  const { data: metadataDocument } = await supabase
    .from("documents")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .contains("metadata", { commitment_id: commitmentId })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return metadataDocument ?? null
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params
  const fallbackUrl = new URL(`/s/${token}/commitments`, request.url)

  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_commitments",
    })
    if (!access.company_id) {
      return NextResponse.redirect(fallbackUrl)
    }

    const supabase = createServiceSupabaseClient()
    const { data: commitment } = await supabase
      .from("commitments")
      .select("id, org_id, project_id, company_id, status, executed_at, source_document_id, signature_envelope_id")
      .eq("org_id", access.org_id)
      .eq("project_id", access.project_id)
      .eq("company_id", access.company_id)
      .eq("id", id)
      .maybeSingle()

    if (!commitment || commitment.executed_at || commitment.status === "canceled") {
      return NextResponse.redirect(fallbackUrl)
    }

    const document = await findSubcontractDocument({
      orgId: access.org_id,
      projectId: access.project_id,
      commitmentId: id,
      sourceDocumentId: commitment.source_document_id,
    })

    if (!document?.id || document.status === "signed") {
      return NextResponse.redirect(fallbackUrl)
    }

    const { data: signingRequests } = await supabase
      .from("document_signing_requests")
      .select("id, status, required, sequence, sent_to_email")
      .eq("org_id", access.org_id)
      .eq("document_id", document.id)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    const nextRequest = pickNextRequiredRequest(signingRequests ?? [])
    if (!nextRequest?.id) {
      return NextResponse.redirect(fallbackUrl)
    }

    let contactEmail: string | null = null
    if (access.contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("email")
        .eq("org_id", access.org_id)
        .eq("id", access.contact_id)
        .maybeSingle()
      contactEmail = contact?.email?.trim()?.toLowerCase() ?? null
    }

    const nextSignerEmail = nextRequest.sent_to_email?.trim()?.toLowerCase() ?? null
    const emailMatches = !contactEmail || !nextSignerEmail || contactEmail === nextSignerEmail
    if (!emailMatches) {
      return NextResponse.redirect(fallbackUrl)
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
      .eq("org_id", access.org_id)
      .eq("id", nextRequest.id)

    if (updateError) {
      throw new Error(`Failed to issue signing request: ${updateError.message}`)
    }

    return NextResponse.redirect(buildSigningUrl(rawSigningToken, request))
  } catch (error) {
    console.error("Failed to continue subcontract signing", error)
    return NextResponse.redirect(fallbackUrl)
  }
}
