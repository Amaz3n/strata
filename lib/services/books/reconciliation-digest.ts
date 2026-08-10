import type { ReconciliationSeverity } from "@/lib/services/reports/reconciliation-types"
import { RECONCILIATION_QUEUE_LABELS } from "@/lib/services/reports/reconciliation-types"

/**
 * Turns one reconciliation run into something a bookkeeper can act on without
 * opening Arc first.
 *
 * The drift notification used to carry a single sentence — "24 new accounting
 * reconciliation issues" — which told four people something was wrong and gave
 * them no way to judge whether it mattered tonight or next week. Everything a
 * triage decision needs is already on the persisted items: a severity, a money
 * delta, and for project findings a deep link to the screen that cures it. This
 * module is the shaping step, kept pure so the ranking is testable without a
 * database.
 */

/** Categories the org-level sweep emits, with the label a person would recognise. */
const ORG_CATEGORY_LABELS: Record<string, string> = {
  connection_unhealthy: "Accounting connection needs re-authorization",
  connection_stale: "Accounting connection not responding",
  sync_error: "Sync failing with an error",
  unreconciled_sync_record: "Records waiting to sync",
  rails_payment_missing_from_books: "Paid money missing from the ledger",
  rails_payment_amount_mismatch: "Payment disagrees with the ledger",
  bank_account_unreconciled: "Bank account never reconciled",
  bank_transaction_unmatched: "Unmatched bank transactions",
  unposted_journal: "Unposted journal entries",
  retainage_control: "Retainage control out of balance",
  projection_blocked_by_closed_period: "Postings blocked by a closed period",
  projection_failed: "Postings failed to project",
}

/**
 * Severity for the org-level categories. Project findings carry their own
 * severity from the integrity checks, so they never reach this map.
 *
 * The dividing line is whether the books are currently WRONG (critical) or
 * merely UNPROVEN (warning). A settled payment with no ledger row is money that
 * moved and was never recorded; a stale connection is a sync that is behind.
 */
const ORG_CATEGORY_SEVERITY: Record<string, ReconciliationSeverity> = {
  connection_unhealthy: "critical",
  connection_stale: "warning",
  sync_error: "critical",
  unreconciled_sync_record: "warning",
  rails_payment_missing_from_books: "critical",
  rails_payment_amount_mismatch: "critical",
  bank_account_unreconciled: "warning",
  bank_transaction_unmatched: "info",
  unposted_journal: "warning",
  retainage_control: "critical",
  projection_blocked_by_closed_period: "warning",
  projection_failed: "warning",
}

/** Every ledger tie-out shares one label and one severity: the books do not balance. */
const TIE_OUT_PREFIX = "tie_out_"

const TIE_OUT_LABELS: Record<string, string> = {
  trial_balance: "Trial balance does not balance",
  balance_sheet: "Balance sheet does not balance",
  job_cost_control: "Job cost control does not tie to the subledger",
  ar_control: "AR control does not tie to open invoices",
  ap_control: "AP control does not tie to open bills",
  retainage_receivable_control: "Retainage receivable does not tie",
  retainage_payable_control: "Retainage payable does not tie",
}

export interface ReconciliationDigestRow {
  category: string
  entityType: string | null
  differenceCents: number | null
  status: string
  details: Record<string, unknown> | null
}

export interface ReconciliationDigestGroup {
  label: string
  severity: ReconciliationSeverity
  count: number
  amountCents: number
}

export interface ReconciliationDigestItem {
  label: string
  severity: ReconciliationSeverity
  description: string
  projectId: string | null
  amountCents: number | null
  href: string | null
}

export interface ReconciliationDigest {
  newCount: number
  openCount: number
  resolvedCount: number
  criticalCount: number
  /** Absolute money on the open items that carry a delta. Not a loss — an unexplained gap. */
  exposureCents: number
  groups: ReconciliationDigestGroup[]
  topItems: ReconciliationDigestItem[]
  /** What this pass did NOT cover. A truncated sweep must never read as a clean one. */
  coverageNotes: string[]
}

const SEVERITY_RANK: Record<ReconciliationSeverity, number> = { critical: 0, warning: 1, info: 2 }

export function reconciliationCategoryLabel(category: string): string {
  if (category.startsWith(TIE_OUT_PREFIX)) {
    const code = category.slice(TIE_OUT_PREFIX.length)
    return TIE_OUT_LABELS[code] ?? "Ledger tie-out failed"
  }
  return (
    ORG_CATEGORY_LABELS[category] ??
    RECONCILIATION_QUEUE_LABELS[category as keyof typeof RECONCILIATION_QUEUE_LABELS] ??
    category.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase())
  )
}

export function reconciliationCategorySeverity(
  category: string,
  details: Record<string, unknown> | null,
): ReconciliationSeverity {
  // Project integrity checks already graded themselves; that grade wins.
  const declared = details?.severity
  if (declared === "critical" || declared === "warning" || declared === "info") return declared
  if (category.startsWith(TIE_OUT_PREFIX)) return "critical"
  return ORG_CATEGORY_SEVERITY[category] ?? "warning"
}

function stringField(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/**
 * The one line that explains this finding. Project checks write a real sentence;
 * the org-level categories carry raw fields, so the sentence is built here rather
 * than leaving the reader to interpret `{"status":"needs_review"}`.
 */
function describeRow(row: ReconciliationDigestRow, label: string): string {
  const details = row.details
  const written = stringField(details, "description")
  if (written) return written

  const provider = stringField(details, "provider")
  const providerName = provider === "qbo" ? "QuickBooks" : provider

  switch (row.category) {
    case "connection_unhealthy":
      return `${providerName ?? "The accounting"} connection is ${stringField(details, "status") ?? "not active"} — nothing is syncing until it is reconnected.`
    case "connection_stale": {
      // Last contact is the later of a successful transaction sync and an inbound
      // change poll, matching how the sweep decides staleness.
      const synced = stringField(details, "last_sync_at")
      const polled = stringField(details, "last_inbound_poll_at")
      const last = [synced, polled]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
        .at(-1)
      return last
        ? `${providerName ?? "The accounting"} connection has not been reached since ${formatDay(last)}.`
        : `${providerName ?? "The accounting"} connection has never been reached.`
    }
    case "sync_error":
      return stringField(details, "error") ?? `A ${row.entityType ?? "record"} failed to sync.`
    case "unreconciled_sync_record":
      return (
        stringField(details, "error") ??
        `A ${row.entityType ?? "record"} is ${stringField(details, "status") ?? "not synced"} and has not cleared.`
      )
    case "bank_account_unreconciled":
      return `${stringField(details, "name") ?? "A bank account"} has no closed reconciliation on or before ${formatDay(stringField(details, "as_of"))}.`
    case "bank_transaction_unmatched":
      return `A posted transaction from ${formatDay(stringField(details, "transaction_date"))} has no confirmed match.`
    case "unposted_journal":
      return `Journal entry ${stringField(details, "posting_key") ?? ""} is still a draft.`.replace("  ", " ")
    case "rails_payment_missing_from_books":
      return "A disbursement settled on the payment rails but never produced a ledger payment."
    case "rails_payment_amount_mismatch":
      return "The payment rails and the ledger disagree on what left the bank."
    default:
      return stringField(details, "label") ?? label
  }
}

function formatDay(value: string | null): string {
  if (!value) return "an unknown date"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "an unknown date"
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

export function formatDigestMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

export function buildReconciliationDigest(input: {
  rows: ReconciliationDigestRow[]
  newCount: number
  resolvedCount: number
  projectNames: Record<string, string>
  /** How many project checks the sweep skipped because the per-run cap bit. */
  projectsSkipped: number
  failedChecks: string[]
  booksEnabled: boolean
  topItemLimit?: number
}): ReconciliationDigest {
  const open = input.rows.filter((row) => row.status === "open" || row.status === "explained")

  const groupMap = new Map<string, ReconciliationDigestGroup>()
  const items: ReconciliationDigestItem[] = []
  let exposureCents = 0
  let criticalCount = 0

  for (const row of open) {
    const label = reconciliationCategoryLabel(row.category)
    const severity = reconciliationCategorySeverity(row.category, row.details)
    const amount = row.differenceCents === null ? null : Math.abs(row.differenceCents)
    if (severity === "critical") criticalCount += 1
    if (amount) exposureCents += amount

    const group = groupMap.get(label)
    if (group) {
      group.count += 1
      group.amountCents += amount ?? 0
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[group.severity]) group.severity = severity
    } else {
      groupMap.set(label, { label, severity, count: 1, amountCents: amount ?? 0 })
    }

    const projectId = stringField(row.details, "project_id")
    items.push({
      label,
      severity,
      description: describeRow(row, label),
      projectId: projectId ? (input.projectNames[projectId] ?? projectId) : null,
      amountCents: amount,
      href: stringField(row.details, "href"),
    })
  }

  // Severity first, then money: the reader's next hour should go to the finding
  // that is both wrong and large, not to whichever row the sweep wrote first.
  items.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    return (b.amountCents ?? 0) - (a.amountCents ?? 0)
  })

  const groups = [...groupMap.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    return b.count - a.count
  })

  const coverageNotes: string[] = []
  if (input.projectsSkipped > 0) {
    coverageNotes.push(
      `${input.projectsSkipped} project${input.projectsSkipped === 1 ? " was" : "s were"} not inspected — this pass is not a clean bill of health for them.`,
    )
  }
  if (input.failedChecks.length > 0) {
    coverageNotes.push(`Some checks could not run (${input.failedChecks.join(", ")}), so results may be incomplete.`)
  }
  if (!input.booksEnabled) {
    coverageNotes.push("Arc Books is off for this org, so ledger tie-outs and journal checks did not run.")
  }

  return {
    newCount: input.newCount,
    openCount: open.length,
    resolvedCount: input.resolvedCount,
    criticalCount,
    exposureCents,
    groups,
    topItems: items.slice(0, input.topItemLimit ?? 6),
    coverageNotes,
  }
}
