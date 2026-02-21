import { createHmac, randomBytes } from "crypto"
import { NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken } from "@/lib/services/portal-access"
import { getChangeOrderForPortal } from "@/lib/services/change-orders"

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

export async function GET(request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params
  const fallbackUrl = new URL(`/p/${token}/change-orders/${id}`, request.url)

  try {
    const access = await validatePortalToken(token)
    if (!access || !access.permissions.can_approve_change_orders) {
      return NextResponse.redirect(fallbackUrl)
    }

    const changeOrder = await getChangeOrderForPortal(id, access.org_id, access.project_id)
    if (!changeOrder || !changeOrder.client_visible || changeOrder.status === "approved") {
      return NextResponse.redirect(fallbackUrl)
    }

    const supabase = createServiceSupabaseClient()

    const { data: sourcedDocument } = await supabase
      .from("documents")
      .select("id, status")
      .eq("org_id", access.org_id)
      .eq("source_entity_type", "change_order")
      .eq("source_entity_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    let documentId = sourcedDocument?.id ?? null
    let documentStatus = sourcedDocument?.status ?? null

    if (!documentId) {
      const { data: metadataDocument } = await supabase
        .from("documents")
        .select("id, status")
        .eq("org_id", access.org_id)
        .contains("metadata", { change_order_id: id })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      documentId = metadataDocument?.id ?? null
      documentStatus = metadataDocument?.status ?? null
    }

    if (!documentId || documentStatus === "signed") {
      return NextResponse.redirect(fallbackUrl)
    }

    const { data: signingRequests } = await supabase
      .from("document_signing_requests")
      .select("id, status, required, sequence, sent_to_email")
      .eq("org_id", access.org_id)
      .eq("document_id", documentId)
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
    console.error("Failed to continue change-order signing", error)
    return NextResponse.redirect(fallbackUrl)
  }
}
