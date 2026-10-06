import { accountingCutoff, isInvoiceReceivableAsOf, loadSubledgerSettlements } from "@/lib/services/books/subledger-settlements"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { applyReportingExclusion, getReportingExcludedProjectIds } from "@/lib/services/reporting-scope"
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
  customer_id?: string | null
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

async function loadAll<T>(load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, label: string) {
  const pageSize = 500
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await load(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
    if (rows.length >= 250_000) throw new Error(`${label} exceeded the report safety limit`)
  }
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })
  const asOfDate = asOf ?? todayIsoDateOnly()
  accountingCutoff(asOfDate)

  let query = supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, title, status, issue_date, due_date, sent_at, total_cents, balance_due_cents, metadata, project:projects(name)")
    .eq("org_id", resolvedOrgId)
    // Load all invoices issued by the cutoff. Current status alone is not an
    // as-of fact: an invoice paid or voided later was still open historically.
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .order("id")

  if (projectId) {
    query = query.eq("project_id", projectId)
  } else {
    const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId)
    query = applyReportingExclusion(query, excludedProjectIds)
  }

  query = query.lte("issue_date", asOfDate)
  const data = await loadAll<any>((from, to) => query.range(from, to), "invoices for AR aging")

  const invoiceRows = data.filter(row => isInvoiceReceivableAsOf(row, asOfDate))
  const invoiceIds = invoiceRows.map((row: any) => String(row.id))
  const paidByInvoice = await loadSubledgerSettlements(supabase, resolvedOrgId, "receivable", invoiceIds, asOfDate)

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

  const rows: ARAgingRow[] = invoiceRows.map((row: any) => {
    const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
    const balanceDueCents = totalCents - (paidByInvoice.get(String(row.id)) ?? 0)
    const openBalanceCents = balanceDueCents
    const isPaid = openBalanceCents === 0

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
      customer_id: row.metadata?.customer_id ? `${row.metadata.customer_type ?? "customer"}:${row.metadata.customer_id}` : row.metadata?.accounting_customer_ref?.id ? `accounting:${row.metadata.accounting_customer_ref.id}` : null,
      customer_name: row.metadata?.customer_name ?? row.metadata?.accounting_customer_ref?.name ?? null,
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
