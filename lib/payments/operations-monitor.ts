export const RECONCILIATION_STALE_HOURS = 48

/**
 * How long a still-open payment-operations incident stays quiet before it says
 * so again.
 *
 * Incidents exist so an hourly watchdog does not send an hourly email, but the
 * first version never re-read `last_notified_at`: an incident open for thirty
 * days alerted exactly once, on day one, and then went silent while the money
 * stayed stuck. Daily is the cadence that matches how the queue is worked —
 * someone looks at payables once a business day — and it is the longest a
 * payment can be stuck without anybody being told again.
 */
export const INCIDENT_RENOTIFY_HOURS = 24

export function incidentRenotifyCutoff(now = new Date()): string {
  return new Date(now.getTime() - INCIDENT_RENOTIFY_HOURS * 60 * 60 * 1000).toISOString()
}

export interface ReconciliationMonitoringPolicy {
  last_reconciled_at: string | null
  reconciliation_monitoring_started_at: string | null
  created_at: string
}

/**
 * A newly enabled rail gets the same 48-hour window as one that last
 * reconciled successfully. A null cursor by itself must not mean "48 hours
 * stale" immediately after enablement.
 */
export function isPaymentReconciliationStale(
  policy: ReconciliationMonitoringPolicy,
  now = new Date(),
): boolean {
  // The monitoring start can be newer than the last success when a rail is
  // disabled and later re-enabled. In that case the new enablement starts a
  // fresh grace window instead of resurrecting the old stale timestamp.
  const referenceMs = [
    policy.last_reconciled_at,
    policy.reconciliation_monitoring_started_at,
    policy.created_at,
  ].reduce((latest, value) => {
    if (!value) return latest
    const candidate = new Date(value).getTime()
    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest
  }, Number.NEGATIVE_INFINITY)
  if (!Number.isFinite(referenceMs)) return false
  return now.getTime() - referenceMs > RECONCILIATION_STALE_HOURS * 60 * 60 * 1000
}

export function paymentOperationsAlertDetails(payload: Record<string, unknown>): string[] {
  const findings = Array.isArray(payload.findings) ? payload.findings : []
  const details = findings
    .map((finding) => (finding && typeof finding === "object" ? Reflect.get(finding, "detail") : null))
    .filter((detail): detail is string => typeof detail === "string")
  if (details.length > 0) return details

  if (payload.reason !== "stale_payment_state") return []
  const staleDisbursements = Math.max(0, Number(payload.stale_disbursements) || 0)
  const staleRuns = Math.max(0, Number(payload.stale_runs) || 0)
  const thresholdHours = Math.max(0, Number(payload.threshold_hours) || 0)
  const total = staleDisbursements + staleRuns
  if (total === 0) return []

  const breakdown = [
    staleDisbursements > 0
      ? `${staleDisbursements} disbursement${staleDisbursements === 1 ? "" : "s"}`
      : null,
    staleRuns > 0
      ? `${staleRuns} payment run${staleRuns === 1 ? "" : "s"}`
      : null,
  ].filter((value): value is string => Boolean(value)).join(" and ")

  return [
    `${breakdown} ${total === 1 ? "has" : "have"} remained in a non-terminal state for more than ${thresholdHours} hours.`,
  ]
}
