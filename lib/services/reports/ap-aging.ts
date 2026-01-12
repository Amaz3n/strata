import { requireOrgContext } from "@/lib/services/context"
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
  rows: APAgingRow[]
  totals: APAgingTotals
}

export async function getApAgingReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId?: string
  asOf?: string
  orgId?: string
}): Promise<APAgingReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  let query = supabase
    .from("vendor_bills")
    .select(
      "id, org_id, project_id, bill_number, status, bill_date, due_date, total_cents, paid_cents, currency, metadata, project:projects(name), commitment:commitments(id, title)",
    )
    .eq("org_id", resolvedOrgId)
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load vendor bills for AP aging: ${error.message}`)
  }

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
    const paidCents = typeof row.paid_cents === "number"
      ? row.paid_cents
      : row.status === "paid"
        ? totalCents
        : 0
    const isPaid = paidCents >= totalCents && totalCents > 0 ? true : row.status === "paid"
    const openBalanceCents = Math.max(0, totalCents - paidCents)
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
