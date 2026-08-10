/**
 * The dashboard's AR rollup payload, and the correction that makes it agree
 * with the AR aging report before the replacing migration is deployed.
 *
 * Pure by design, and here rather than in `lib/services/dashboard.ts` for the
 * same reason `poc-inputs.ts` and `payables-rules.ts` are here: this arithmetic
 * has to mirror `dashboard_invoice_rollup`'s SQL exactly, and the only way to
 * hold it to that is a test that can execute it.
 */

/** Shape returned by the `dashboard_invoice_rollup` DB function. */
export type InvoiceRollupPayload = {
  total_invoiced: number
  total_collected: number
  total_overdue: number
  revenue_series: Array<{ key: string; revenue_cents: number }> | null
  ar_aging: {
    current: number
    no_due_date: number
    one_to_thirty: number
    thirty_one_to_sixty: number
    sixty_one_to_ninety: number
    over_ninety: number
  }
  /**
   * `true` once the deployed function aggregates `BILLED_INVOICE_STATUSES` only.
   * Absent on the older function, which excluded `void` alone and therefore
   * counted unsent `draft` and `saved` invoices as receivables — the same
   * invoices the AR aging report and Books leave out.
   *
   * The marker is what lets `subtractPreIssuanceInvoices` correct the old
   * payload without double-subtracting from the new one. Delete both the marker
   * check and the correction once the replacing migration is deployed
   * everywhere.
   */
  billed_only?: boolean
}

/**
 * Rows that have not been issued to anyone, in the shape the correction needs.
 * `draft` and `saved` are the editable, still-deletable pair; neither is a
 * receivable.
 */
export type PreIssuanceInvoiceRow = {
  total_cents: number | null
  balance_due_cents: number | null
  due_date: string | null
  issue_date: string | null
  created_at: string | null
}

export const EMPTY_INVOICE_ROLLUP: InvoiceRollupPayload = {
  total_invoiced: 0,
  total_collected: 0,
  total_overdue: 0,
  revenue_series: [],
  ar_aging: {
    current: 0,
    no_due_date: 0,
    one_to_thirty: 0,
    thirty_one_to_sixty: 0,
    sixty_one_to_ninety: 0,
    over_ninety: 0,
  },
  billed_only: true,
}

/**
 * Removes unsent invoices from a rollup produced by the pre-`billed_only`
 * function, so the desk agrees with the AR aging report before the replacing
 * migration is deployed.
 *
 * Mirrors the SQL it corrects exactly: monthly revenue keys off
 * `coalesce(issue_date, created_at)`, aging buckets off `current_date - due_date`
 * over positive balances, overdue off status-or-past-due. Delete this together
 * with the `billed_only` marker once the migration has shipped.
 */
export function subtractPreIssuanceInvoices(
  rollup: InvoiceRollupPayload,
  rows: PreIssuanceInvoiceRow[],
  now: Date,
): InvoiceRollupPayload {
  if (rollup.billed_only === true || rows.length === 0) return rollup

  const seriesByKey = new Map((rollup.revenue_series ?? []).map((point) => [point.key, point.revenue_cents]))
  const aging = { ...rollup.ar_aging }
  let totalInvoiced = rollup.total_invoiced
  let totalCollected = rollup.total_collected
  let totalOverdue = rollup.total_overdue
  const todayKeyUtc = now.toISOString().slice(0, 10)

  for (const row of rows) {
    const total = row.total_cents ?? 0
    const balance = row.balance_due_cents ?? 0
    totalInvoiced -= total
    totalCollected -= total - balance

    const issuedAt = row.issue_date ?? row.created_at
    if (issuedAt) {
      const key = issuedAt.slice(0, 7)
      if (seriesByKey.has(key)) seriesByKey.set(key, (seriesByKey.get(key) ?? 0) - total)
    }

    if (balance <= 0) continue
    if (!row.due_date) {
      aging.no_due_date -= balance
      continue
    }
    if (row.due_date < todayKeyUtc) totalOverdue -= balance
    const daysOverdue = Math.floor(
      (Date.parse(`${todayKeyUtc}T00:00:00Z`) - Date.parse(`${row.due_date}T00:00:00Z`)) / 86_400_000,
    )
    if (daysOverdue <= 0) aging.current -= balance
    else if (daysOverdue <= 30) aging.one_to_thirty -= balance
    else if (daysOverdue <= 60) aging.thirty_one_to_sixty -= balance
    else if (daysOverdue <= 90) aging.sixty_one_to_ninety -= balance
    else aging.over_ninety -= balance
  }

  const floor = (value: number) => Math.max(0, value)
  return {
    total_invoiced: floor(totalInvoiced),
    total_collected: floor(totalCollected),
    total_overdue: floor(totalOverdue),
    revenue_series: Array.from(seriesByKey.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, revenue_cents]) => ({ key, revenue_cents: floor(revenue_cents) })),
    ar_aging: {
      current: floor(aging.current),
      no_due_date: floor(aging.no_due_date),
      one_to_thirty: floor(aging.one_to_thirty),
      thirty_one_to_sixty: floor(aging.thirty_one_to_sixty),
      sixty_one_to_ninety: floor(aging.sixty_one_to_ninety),
      over_ninety: floor(aging.over_ninety),
    },
    billed_only: true,
  }
}
