import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { applyReportingExclusion, getReportingExcludedProjectIds } from "@/lib/services/reporting-scope"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

const ROW_CAP = 500

export type PayAppRegisterRow = {
  pay_application_id: string
  project_id: string | null
  project_name: string | null
  application_number: number
  period_end: string | null
  status: string
  contract_sum_to_date_cents: number
  total_completed_stored_cents: number
  retainage_cents: number
  current_payment_due_cents: number
  balance_to_finish_cents: number
  invoice_id: string | null
  submitted_at: string | null
  approved_at: string | null
  paid_at: string | null
}

export type PayAppRegisterReport = {
  as_of: string
  project_id?: string
  rows: PayAppRegisterRow[]
  total_count: number
  /**
   * Position per project, taken from that project's latest non-void application —
   * pay-app money columns are cumulative, so summing rows would double-count.
   */
  totals: {
    project_count: number
    contract_sum_cents: number
    completed_stored_cents: number
    retainage_held_cents: number
    balance_to_finish_cents: number
    open_payment_due_cents: number
  }
}

export async function getPayAppRegisterReport({
  projectId,
  orgId,
}: {
  projectId?: string
  orgId?: string
}): Promise<PayAppRegisterReport> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase
    .from("pay_applications")
    .select(
      "id, project_id, application_number, period_end, status, contract_sum_to_date_cents, total_completed_stored_cents, retainage_cents, current_payment_due_cents, balance_to_finish_cents, invoice_id, submitted_at, approved_at, paid_at, project:projects(name)",
      { count: "exact" },
    )
    .eq("org_id", resolvedOrgId)
    .order("period_end", { ascending: false, nullsFirst: false })
    .order("application_number", { ascending: false })
    .limit(ROW_CAP)

  if (projectId) {
    query = query.eq("project_id", projectId)
  } else {
    const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId)
    query = applyReportingExclusion(query, excludedProjectIds)
  }

  const { data, count, error } = await query
  if (error) {
    throw new Error(`Failed to load pay application register: ${error.message}`)
  }

  const rows: PayAppRegisterRow[] = (data ?? []).map((row: any) => ({
    pay_application_id: row.id,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
    application_number: Number(row.application_number ?? 0),
    period_end: row.period_end ?? null,
    status: row.status ?? "draft",
    contract_sum_to_date_cents: Number(row.contract_sum_to_date_cents ?? 0),
    total_completed_stored_cents: Number(row.total_completed_stored_cents ?? 0),
    retainage_cents: Number(row.retainage_cents ?? 0),
    current_payment_due_cents: Number(row.current_payment_due_cents ?? 0),
    balance_to_finish_cents: Number(row.balance_to_finish_cents ?? 0),
    invoice_id: row.invoice_id ?? null,
    submitted_at: row.submitted_at ?? null,
    approved_at: row.approved_at ?? null,
    paid_at: row.paid_at ?? null,
  }))

  const latestByProject = new Map<string, PayAppRegisterRow>()
  let openPaymentDueCents = 0
  for (const row of rows) {
    if (row.status === "void") continue
    if (row.status === "submitted" || row.status === "approved" || row.status === "invoiced") {
      openPaymentDueCents += row.current_payment_due_cents
    }
    const key = row.project_id ?? "unassigned"
    const current = latestByProject.get(key)
    if (!current || row.application_number > current.application_number) {
      latestByProject.set(key, row)
    }
  }

  const latest = Array.from(latestByProject.values())
  return {
    as_of: todayIsoDateOnly(),
    project_id: projectId,
    rows,
    total_count: count ?? rows.length,
    totals: {
      project_count: latest.length,
      contract_sum_cents: latest.reduce((sum, row) => sum + row.contract_sum_to_date_cents, 0),
      completed_stored_cents: latest.reduce((sum, row) => sum + row.total_completed_stored_cents, 0),
      retainage_held_cents: latest.reduce((sum, row) => sum + row.retainage_cents, 0),
      balance_to_finish_cents: latest.reduce((sum, row) => sum + row.balance_to_finish_cents, 0),
      open_payment_due_cents: openPaymentDueCents,
    },
  }
}
