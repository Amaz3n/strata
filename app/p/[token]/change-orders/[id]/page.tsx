import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { getChangeOrderForPortal } from "@/lib/services/change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ChangeOrderApprovalClient } from "./approval-client"

interface Params {
  params: Promise<{ token: string; id: string }>
}

export const revalidate = 0

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

  const supabase = createServiceSupabaseClient()
  const viewedAt = new Date().toISOString()
  const viewedMetadata = {
    ...(changeOrder.metadata ?? {}),
    portal_last_viewed_at: viewedAt,
    portal_last_viewed_by_contact_id: access.contact_id ?? null,
  }
  await supabase
    .from("change_orders")
    .update({ metadata: viewedMetadata })
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq("id", changeOrder.id)

  const [orgResult, projectResult] = await Promise.all([
    supabase.from("orgs").select("name, logo_url, address").eq("id", access.org_id).maybeSingle(),
    supabase.from("projects").select("name, location").eq("id", access.project_id).maybeSingle(),
  ])

  return (
    <ChangeOrderApprovalClient
      token={token}
      changeOrder={{ ...changeOrder, metadata: viewedMetadata }}
      org={{
        name: orgResult.data?.name ?? null,
        logoUrl: orgResult.data?.logo_url ?? null,
        address: orgResult.data?.address ?? null,
      }}
      project={{
        name: projectResult.data?.name ?? null,
        location: projectResult.data?.location ?? null,
      }}
    />
  )
}
