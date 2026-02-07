import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { getChangeOrderForPortal } from "@/lib/services/change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ChangeOrderApprovalClient } from "./approval-client"

interface Params {
  params: Promise<{ token: string; id: string }>
}

export const revalidate = 0

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

export default async function ChangeOrderApprovalPage({ params }: Params) {
  const { token, id } = await params
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_approve_change_orders) {
    notFound()
  }

  const changeOrder = await getChangeOrderForPortal(id, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    notFound()
  }

  let canContinueSigning = false
  const supabase = createServiceSupabaseClient()

  const { data: sourcedDocument } = await supabase
    .from("documents")
    .select("id, status")
    .eq("org_id", access.org_id)
    .eq("source_entity_type", "change_order")
    .eq("source_entity_id", changeOrder.id)
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
      .contains("metadata", { change_order_id: changeOrder.id })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    documentId = metadataDocument?.id ?? null
    documentStatus = metadataDocument?.status ?? null
  }

  if (documentId && documentStatus !== "signed") {
    const { data: signingRequests } = await supabase
      .from("document_signing_requests")
      .select("id, status, required, sequence, sent_to_email")
      .eq("org_id", access.org_id)
      .eq("document_id", documentId)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    const nextRequired = pickNextRequiredRequest(signingRequests ?? [])

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

    const nextSignerEmail = nextRequired?.sent_to_email?.trim()?.toLowerCase() ?? null
    const emailMatches = !contactEmail || !nextSignerEmail || contactEmail === nextSignerEmail
    canContinueSigning = !!nextRequired?.id && emailMatches
  }

  return (
    <ChangeOrderApprovalClient
      changeOrder={changeOrder}
      continueSigningUrl={canContinueSigning ? `/p/${token}/change-orders/${id}/continue` : null}
    />
  )
}
