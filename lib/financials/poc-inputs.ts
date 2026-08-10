/**
 * The one definition of every percentage-of-completion input.
 *
 * Pure by design. The POC snapshot resolves one project at a time; the WIP
 * over/under report batches its change-order and invoice rollups across a whole
 * org and cannot afford per-project round trips. Sharing a *resolver* would have
 * forced one of them to give that up, so what is shared is the decision — how
 * raw rows become inputs — while each caller keeps the query shape it needs.
 *
 * Before this existed the two hand-rolled their own fallbacks and disagreed, so
 * a snapshot and the report could state different over/under positions for the
 * same project on the same day, and `inputsHash` silently attested to whichever
 * ran last.
 */

export type PocBillingContract = {
  total_cents?: unknown
  snapshot?: unknown
} | null

function centsValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0
}

function contractSnapshot(billingContract: PocBillingContract): Record<string, unknown> {
  const snapshot = billingContract?.snapshot
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : {}
}

export function resolveRevisedContractCents(input: {
  billingContract: PocBillingContract
  totalContractValueCents: number | null
}): number {
  const snapshot = contractSnapshot(input.billingContract)
  return (
    centsValue(snapshot.revised_total_cents) ||
    centsValue(input.billingContract?.total_cents) ||
    centsValue(input.totalContractValueCents) ||
    0
  )
}

/**
 * The original contract, before approved change orders.
 *
 * Purely reported — `computeProjectPoc` passes it through untouched — but it
 * rides in `inputsHash`, so the two callers disagreeing on it was enough to
 * split a snapshot from the report.
 *
 * When the contract carries no explicit original and the inferred one is not
 * positive (approved change orders exceeding the recorded contract, which means
 * the contract record is stale), fall back to the revised total. Reporting an
 * original contract of $0 beside a $120k revised contract is a lie; reporting
 * them as equal at least says "these could not be separated", and
 * `missing_contract_value` already fires when the revised total is itself
 * missing.
 */
export function resolveOriginalContractCents(input: {
  billingContract: PocBillingContract
  revisedContractCents: number
  approvedChangeOrdersCents: number
}): number {
  const snapshot = contractSnapshot(input.billingContract)
  const explicit =
    centsValue(snapshot.original_total_cents) ||
    centsValue(snapshot.base_contract_cents) ||
    centsValue(snapshot.contract_sum_cents)
  if (explicit > 0) return explicit

  const inferred = input.revisedContractCents - input.approvedChangeOrdersCents
  return inferred > 0 ? inferred : input.revisedContractCents
}

/**
 * Estimate at completion. A budget that has not been forecast falls back to the
 * larger of its adjusted budget and what has actually been spent — an EAC below
 * cost-to-date would report a project as more than complete.
 */
export function resolveEacCents(input: {
  summaryEacCents: number
  adjustedBudgetCents: number
  actualCostCents: number
}): number {
  return input.summaryEacCents || Math.max(input.adjustedBudgetCents, input.actualCostCents)
}

/**
 * Billed to date: the sum of invoices in `BILLED_INVOICE_STATUSES`
 * (`lib/financials/ledger-status.ts`), and nothing
 * else. There is deliberately no fallback to the budget summary's
 * `total_invoiced_cents` — that number is built from cost-coded invoice *lines*
 * (`unit_price × quantity`), which is a different quantity than what the
 * customer was billed, and substituting it whenever a project happened to have
 * no billed invoices mixed two definitions inside one report.
 */
export function resolveBilledCents(invoiceTotalsCents: number[]): number {
  return invoiceTotalsCents.reduce((sum, value) => sum + centsValue(value), 0)
}
