import { accountingCutoff, loadSubledgerSettlements, AS_OF_BILL_STATUSES, isBillPayableAsOf, loadLedgerRemovalDates } from "@/lib/services/books/subledger-settlements"
import { loadClosedPeriodSnapshots } from "@/lib/services/books/closed-snapshots"
import { collectBooksRows } from "@/lib/services/books/paging"
import { isPayableVendorBillStatus } from "@/lib/financials/ledger-status"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { applyReportingExclusion, getReportingExcludedProjectIds } from "@/lib/services/reporting-scope"
import { getAgingBucket, type AgingBucket } from "@/lib/services/reports/aging"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type APAgingRow = {
  bill_id: string
  project_id: string | null
  project_name: string | null
  bill_number: string | null
  status: string | null
  bill_date: string | null
  due_date: string | null
  commitment_id: string | null
  commitment_title: string | null
  total_cents: number
  open_balance_cents: number
  days_past_due: number
  bucket: AgingBucket
}

export type APAgingTotals = Record<AgingBucket, number> & { total_open_cents: number; total_billed_cents: number }

export type APAgingReport = {
  as_of: string
  project_id?: string
  /** When set, this is the aging saved when the period ending `as_of` closed. */
  as_closed?: string | null
  rows: APAgingRow[]
  totals: APAgingTotals
}

export async function getApAgingReport({
  projectId,
  asOf,
  orgId,
  includeExcludedProjects = false,
}: {
  projectId?: string
  asOf?: string
  orgId?: string
  /** The accounting record (saved at close) covers every project, as the ledger does. */
  includeExcludedProjects?: boolean
}): Promise<APAgingReport> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })
  const asOfDate = asOf ?? todayIsoDateOnly()
  accountingCutoff(asOfDate)
  // The end of a closed month reads as it was closed, company-wide.
  if (!projectId) {
    const closed = await loadClosedPeriodSnapshots(resolvedOrgId, { end: asOfDate })
    if (closed) {
      const { statement: _statement, ...saved } = closed.report<APAgingReport & { statement: "ap_aging" }>("ap_aging")
      return { ...saved, as_closed: closed.closedAt }
    }
  }

  let query = supabase
    .from("vendor_bills")
    .select(
      "id, org_id, project_id, bill_number, status, bill_date, due_date, total_cents, retainage_cents, paid_cents, currency, metadata, project:projects(name), commitment:commitments(id, title)",
    )
    .eq("org_id", resolvedOrgId)
    // Pending and rejected bills are read only to find those that were payable at
    // the cutoff and returned since; the rest are never aged as money owed.
    .in("status", [...AS_OF_BILL_STATUSES])
    .lte("bill_date", asOfDate)
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .order("id")

  if (projectId) {
    query = query.eq("project_id", projectId)
  } else if (!includeExcludedProjects) {
    const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId)
    query = applyReportingExclusion(query, excludedProjectIds)
  }

  const loaded = await collectBooksRows((from, to) => query.range(from, to))
  const removedOn = await loadLedgerRemovalDates(resolvedOrgId, loaded.filter(row => !isPayableVendorBillStatus(row.status)).map(row => String(row.id)))
  const data = loaded.filter(row => isBillPayableAsOf(row, asOfDate, removedOn))
  const settlements = await loadSubledgerSettlements(supabase, resolvedOrgId, "payable", data.map(row => row.id), asOfDate)

  const totals: APAgingTotals = {
    current: 0,
    "1_30": 0,
    "31_60": 0,
    "61_90": 0,
    "90_plus": 0,
    paid: 0,
    no_due_date: 0,
    total_open_cents: 0,
    total_billed_cents: 0,
  }

  const rows: APAgingRow[] = (data ?? []).map((row: any) => {
    const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
    const paidCents = settlements.get(String(row.id)) ?? 0
    const openBalanceCents = totalCents - Number(row.retainage_cents ?? 0) - paidCents
    const isPaid = openBalanceCents === 0
    const { bucket, daysPastDue } = getAgingBucket({ dueDate: row.due_date, asOf: asOfDate, isPaid })

    totals.total_billed_cents += totalCents
    totals[bucket] += openBalanceCents
    totals.total_open_cents += openBalanceCents

    return {
      bill_id: row.id,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      bill_number: row.bill_number ?? null,
      status: row.status ?? null,
      bill_date: row.bill_date ?? null,
      due_date: row.due_date ?? null,
      commitment_id: row.commitment?.id ?? row.commitment_id ?? null,
      commitment_title: row.commitment?.title ?? null,
      total_cents: totalCents,
      open_balance_cents: openBalanceCents,
      days_past_due: daysPastDue,
      bucket,
    }
  })

  return { as_of: asOfDate, project_id: projectId, rows, totals }
}
