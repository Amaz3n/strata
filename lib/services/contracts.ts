import type { Contract } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"

function mapContract(row: any): Contract {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    proposal_id: row.proposal_id ?? undefined,
    number: row.number ?? undefined,
    title: row.title,
    status: row.status,
    contract_type: row.contract_type ?? undefined,
    total_cents: row.total_cents ?? undefined,
    currency: row.currency,
    markup_percent: row.markup_percent ? Number(row.markup_percent) : undefined,
    retainage_percent: row.retainage_percent ? Number(row.retainage_percent) : undefined,
    retainage_release_trigger: row.retainage_release_trigger ?? undefined,
    terms: row.terms ?? undefined,
    effective_date: row.effective_date ?? undefined,
    signed_at: row.signed_at ?? undefined,
    signature_data: row.signature_data ?? undefined,
    snapshot: row.snapshot ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function getProjectContract(projectId: string, orgId?: string): Promise<Contract | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to get contract: ${error.message}`)
  return data ? mapContract(data) : null
}

export async function listProjectContracts(projectId: string, orgId?: string): Promise<Contract[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list contracts: ${error.message}`)
  return (data ?? []).map(mapContract)
}
