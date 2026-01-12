import { requireOrgContext } from "@/lib/services/context"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type ChangeOrderLogRow = {
  change_order_id: string
  project_id: string | null
  project_name: string | null
  title: string | null
  status: string | null
  total_cents: number
  approved_at: string | null
  days_impact: number | null
  created_at: string | null
}

export type ChangeOrderLogReport = {
  as_of: string
  project_id?: string
  rows: ChangeOrderLogRow[]
  totals: {
    approved_total_cents: number
    pending_total_cents: number
  }
}

export async function getChangeOrderLogReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId?: string
  asOf?: string
  orgId?: string
}): Promise<ChangeOrderLogReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  let query = supabase
    .from("change_orders")
    .select("id, org_id, project_id, title, status, total_cents, approved_at, days_impact, created_at, project:projects(name)")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load change order log: ${error.message}`)
  }

  let approvedTotal = 0
  let pendingTotal = 0

  const rows: ChangeOrderLogRow[] = (data ?? []).map((row: any) => {
    const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
    const status = row.status ?? null
    if (status === "approved") approvedTotal += totalCents
    else if (status && status !== "void" && status !== "canceled") pendingTotal += totalCents

    return {
      change_order_id: row.id,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      title: row.title ?? null,
      status,
      total_cents: totalCents,
      approved_at: row.approved_at ?? null,
      days_impact: row.days_impact ?? null,
      created_at: row.created_at ?? null,
    }
  })

  return {
    as_of: asOfDate,
    project_id: projectId,
    rows,
    totals: { approved_total_cents: approvedTotal, pending_total_cents: pendingTotal },
  }
}

