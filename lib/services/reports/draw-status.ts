import { requireOrgContext } from "@/lib/services/context"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type DrawStatusRow = {
  draw_id: string
  project_id: string | null
  project_name: string | null
  draw_number: number | null
  title: string | null
  status: string | null
  due_date: string | null
  amount_cents: number
  invoice_id: string | null
  invoice_number: string | null
  invoiced_at: string | null
  paid_at: string | null
}

export type DrawStatusReport = {
  as_of: string
  project_id?: string
  rows: DrawStatusRow[]
}

export async function getDrawStatusReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId?: string
  asOf?: string
  orgId?: string
}): Promise<DrawStatusReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  let query = supabase
    .from("draw_schedules")
    .select(
      "id, org_id, project_id, draw_number, title, status, due_date, amount_cents, invoice_id, invoiced_at, paid_at, project:projects(name), invoice:invoices(invoice_number)",
    )
    .eq("org_id", resolvedOrgId)
    .order("draw_number", { ascending: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load draw status report: ${error.message}`)
  }

  const rows: DrawStatusRow[] = (data ?? []).map((row: any) => ({
    draw_id: row.id,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
    draw_number: typeof row.draw_number === "number" ? row.draw_number : null,
    title: row.title ?? null,
    status: row.status ?? null,
    due_date: row.due_date ?? null,
    amount_cents: typeof row.amount_cents === "number" ? row.amount_cents : 0,
    invoice_id: row.invoice_id ?? null,
    invoice_number: row.invoice?.invoice_number ?? null,
    invoiced_at: row.invoiced_at ?? null,
    paid_at: row.paid_at ?? null,
  }))

  return { as_of: asOfDate, project_id: projectId, rows }
}

