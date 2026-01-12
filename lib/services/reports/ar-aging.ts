import { requireOrgContext } from "@/lib/services/context"
import { getAgingBucket, type AgingBucket } from "@/lib/services/reports/aging"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type ARAgingRow = {
  invoice_id: string
  project_id: string | null
  project_name: string | null
  invoice_number: string | null
  title: string | null
  status: string | null
  issue_date: string | null
  due_date: string | null
  customer_name: string | null
  total_cents: number
  balance_due_cents: number
  open_balance_cents: number
  days_past_due: number
  bucket: AgingBucket
}

export type ARAgingTotals = Record<AgingBucket, number> & { total_open_cents: number; total_invoiced_cents: number }

export type ARAgingReport = {
  as_of: string
  project_id?: string
  rows: ARAgingRow[]
  totals: ARAgingTotals
}

function getInvoiceBalanceDueCents(row: any): number {
  const balance = row.balance_due_cents
  if (typeof balance === "number") return balance
  const fromMeta = row?.metadata?.totals?.balance_due_cents
  if (typeof fromMeta === "number") return fromMeta
  const total = row.total_cents
  return typeof total === "number" ? total : 0
}

export async function getArAgingReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId?: string
  asOf?: string
  orgId?: string
}): Promise<ARAgingReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  let query = supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, title, status, issue_date, due_date, total_cents, balance_due_cents, metadata, project:projects(name)")
    .eq("org_id", resolvedOrgId)
    .neq("status", "void")
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load invoices for AR aging: ${error.message}`)
  }

  const totals: ARAgingTotals = {
    current: 0,
    "1_30": 0,
    "31_60": 0,
    "61_90": 0,
    "90_plus": 0,
    paid: 0,
    no_due_date: 0,
    total_open_cents: 0,
    total_invoiced_cents: 0,
  }

  const rows: ARAgingRow[] = (data ?? []).map((row: any) => {
    const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
    const balanceDueCents = getInvoiceBalanceDueCents(row)
    const openBalanceCents = Math.max(0, balanceDueCents)
    const isPaid = row.status === "paid" || openBalanceCents === 0

    const { bucket, daysPastDue } = getAgingBucket({
      dueDate: row.due_date,
      asOf: asOfDate,
      isPaid,
    })

    totals.total_invoiced_cents += totalCents
    totals[bucket] += openBalanceCents
    totals.total_open_cents += openBalanceCents

    return {
      invoice_id: row.id,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      invoice_number: row.invoice_number ?? null,
      title: row.title ?? null,
      status: row.status ?? null,
      issue_date: row.issue_date ?? null,
      due_date: row.due_date ?? null,
      customer_name: row.metadata?.customer_name ?? null,
      total_cents: totalCents,
      balance_due_cents: balanceDueCents,
      open_balance_cents: openBalanceCents,
      days_past_due: daysPastDue,
      bucket,
    }
  })

  return {
    as_of: asOfDate,
    project_id: projectId,
    rows,
    totals,
  }
}

