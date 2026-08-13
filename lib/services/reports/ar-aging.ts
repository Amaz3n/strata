import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
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
  const asOfEndExclusive = new Date(`${asOfDate}T00:00:00.000Z`)
  asOfEndExclusive.setUTCDate(asOfEndExclusive.getUTCDate() + 1)
  const cutoff = asOfEndExclusive.toISOString()

  let query = supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, title, status, issue_date, due_date, sent_at, total_cents, balance_due_cents, metadata, project:projects(name)")
    .eq("org_id", resolvedOrgId)
    // Load all invoices issued by the cutoff. Current status alone is not an
    // as-of fact: an invoice paid or voided later was still open historically.
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  } else {
    const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId)
    query = applyReportingExclusion(query, excludedProjectIds)
  }

  query = query.lte("issue_date", asOfDate)
  const data = await loadAll<any>((from, to) => query.range(from, to), "invoices for AR aging")

  const invoiceRows = (data ?? []).filter((row: any) => {
    if (typeof row.sent_at === "string" && row.sent_at >= cutoff) return false
    if (BILLED_INVOICE_STATUSES.includes(row.status)) return true
    if (row.status !== "void") return false
    const voidedAt = row.metadata?.voided_at
    return typeof voidedAt === "string" && voidedAt >= cutoff
  })
  const invoiceIds = invoiceRows.map((row: any) => String(row.id))
  const paidByInvoice = new Map<string, number>()
  if (invoiceIds.length > 0) {
    for (let start = 0; start < invoiceIds.length; start += 200) {
      const ids = invoiceIds.slice(start, start + 200)
      const [payments, allocations, reversals, adjustments] = await Promise.all([
        loadAll<any>(
          (from, to) => supabase
            .from("payments")
            .select("id,invoice_id,amount_cents,status,received_at")
            .eq("org_id", resolvedOrgId)
            .in("invoice_id", ids)
            .in("status", ["succeeded", "completed", "paid", "refunded"])
            .lt("received_at", cutoff)
            .range(from, to),
          "invoice payments for AR aging",
        ),
        loadAll<any>(
          (from, to) => supabase
            .from("payment_allocations")
            .select("invoice_id,amount_cents,payment:payments!inner(status,received_at)")
            .eq("org_id", resolvedOrgId)
            .in("invoice_id", ids)
            .in("payment.status", ["succeeded", "completed", "paid", "refunded"])
            .lt("payment.received_at", cutoff)
            .range(from, to),
          "payment allocations for AR aging",
        ),
        loadAll<any>(
          (from, to) => supabase
            .from("payment_reversals")
            .select("invoice_id,amount_cents,status,occurred_at")
            .eq("org_id", resolvedOrgId)
            .in("invoice_id", ids)
            .eq("status", "succeeded")
            .lt("occurred_at", cutoff)
            .range(from, to),
          "payment reversals for AR aging",
        ),
        loadAll<any>(
          (from, to) => supabase
            .from("receivable_adjustments")
            .select("invoice_id,amount_cents,status,effective_date,voided_at")
            .eq("org_id", resolvedOrgId)
            .in("invoice_id", ids)
            .lte("effective_date", asOfDate)
            .range(from, to),
          "receivable adjustments for AR aging",
        ),
      ])
      for (const payment of payments) {
        if (!payment.invoice_id) continue
        paidByInvoice.set(String(payment.invoice_id), (paidByInvoice.get(String(payment.invoice_id)) ?? 0) + Number(payment.amount_cents ?? 0))
      }
      for (const allocation of allocations) {
        paidByInvoice.set(String(allocation.invoice_id), (paidByInvoice.get(String(allocation.invoice_id)) ?? 0) + Number(allocation.amount_cents ?? 0))
      }
      for (const reversal of reversals) {
        paidByInvoice.set(String(reversal.invoice_id), (paidByInvoice.get(String(reversal.invoice_id)) ?? 0) - Number(reversal.amount_cents ?? 0))
      }
      for (const adjustment of adjustments) {
        const wasActive = adjustment.status === "posted" || (typeof adjustment.voided_at === "string" && adjustment.voided_at >= cutoff)
        if (!wasActive) continue
        paidByInvoice.set(String(adjustment.invoice_id), (paidByInvoice.get(String(adjustment.invoice_id)) ?? 0) + Number(adjustment.amount_cents ?? 0))
      }
    }
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

  const rows: ARAgingRow[] = invoiceRows.map((row: any) => {
    const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
    const balanceDueCents = Math.max(0, totalCents - Math.max(0, paidByInvoice.get(String(row.id)) ?? 0))
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
