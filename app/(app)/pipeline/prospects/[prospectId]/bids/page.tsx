import { notFound, redirect } from "next/navigation"

import { requireOrgContext } from "@/lib/services/context"

// Legacy route: prospect bids now live on the prospect's (precon) project.
export default async function ProspectBidsPage({
  params,
}: {
  params: Promise<{ prospectId: string }>
}) {
  const { prospectId } = await params
  const { supabase, orgId } = await requireOrgContext()
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .maybeSingle()
  if (!project) notFound()
  redirect(`/projects/${project.id}/bids`)
}
