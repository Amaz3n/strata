import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * An Arc project's link to its QBO counterpart, stored as `projects.qbo_customer_id`. The link is
 * managed in the project settings sheet (the QuickBooks customer picker); it drives outbound sync
 * (getOrCreateProjectCustomer stamps it onto invoice/bill/expense CustomerRef), import line→project
 * routing, and defaults the import filter. All free Accounting API — no premium Projects API.
 */
export type ProjectQboLink = {
  qboCustomerId: string | null
  qboCustomerName: string | null
}

export async function getProjectQboLink({ projectId, orgId }: { projectId: string; orgId?: string }): Promise<ProjectQboLink> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("projects")
    .select("qbo_customer_id, qbo_customer_name")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .maybeSingle()
  return {
    qboCustomerId: (data?.qbo_customer_id as string | null) ?? null,
    qboCustomerName: (data?.qbo_customer_name as string | null) ?? null,
  }
}
