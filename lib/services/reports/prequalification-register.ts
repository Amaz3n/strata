import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type PrequalificationRegisterRow = {
  company_id: string
  company_name: string
  status: string
  submitted_at: string | null
  reviewed_at: string | null
  expires_at: string | null
  single_project_limit_cents: number | null
  aggregate_limit_cents: number | null
  emr: number | null
  bonding_single_cents: number | null
  bonding_aggregate_cents: number | null
  trades: string[]
}

export type PrequalificationRegisterReport = {
  as_of: string
  rows: PrequalificationRegisterRow[]
}

/** Latest prequalification per company — the register a bid invite is checked against. */
export async function getPrequalificationRegisterReport(orgId?: string): Promise<PrequalificationRegisterReport> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("directory.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("prequalifications")
    .select(
      "company_id, status, submitted_at, reviewed_at, expires_at, single_project_limit_cents, aggregate_limit_cents, emr, bonding_single_cents, bonding_aggregate_cents, trades, company:companies!inner(name)",
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load prequalification register: ${error.message}`)
  }

  const seen = new Set<string>()
  const rows: PrequalificationRegisterRow[] = []
  for (const row of (data ?? []) as any[]) {
    if (seen.has(row.company_id)) continue
    seen.add(row.company_id)
    const company = Array.isArray(row.company) ? row.company[0] : row.company
    rows.push({
      company_id: row.company_id,
      company_name: company?.name ?? "—",
      status: row.status ?? "draft",
      submitted_at: row.submitted_at ?? null,
      reviewed_at: row.reviewed_at ?? null,
      expires_at: row.expires_at ?? null,
      single_project_limit_cents: typeof row.single_project_limit_cents === "number" ? row.single_project_limit_cents : null,
      aggregate_limit_cents: typeof row.aggregate_limit_cents === "number" ? row.aggregate_limit_cents : null,
      emr: typeof row.emr === "number" ? row.emr : null,
      bonding_single_cents: typeof row.bonding_single_cents === "number" ? row.bonding_single_cents : null,
      bonding_aggregate_cents: typeof row.bonding_aggregate_cents === "number" ? row.bonding_aggregate_cents : null,
      trades: Array.isArray(row.trades) ? row.trades : [],
    })
  }

  rows.sort((a, b) => a.company_name.localeCompare(b.company_name))
  return { as_of: todayIsoDateOnly(), rows }
}
