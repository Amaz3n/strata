/**
 * The one definition of an invoice's lifecycle.
 *
 * An invoice has FOUR independent dimensions and they used to be crushed into a
 * single `status` column that any caller could set:
 *
 *   1. lifecycle   — draft → issued → (partial) → paid, or void
 *   2. delivery    — not_sent / queued / sending / sent / delivered / bounced / failed
 *   3. approval    — not_required / draft / pending / approved / rejected
 *   4. accounting  — the row in `accounting_sync_records`
 *
 * Only (1) lives in `invoices.status`, and only the server writes it. Callers
 * express INTENT (`issue: true`) and the server derives the state; that is what
 * makes "paid with a full balance due" unrepresentable instead of merely
 * unlikely. `overdue` is not a state anyone stores on purpose either — it is
 * `issued && balance > 0 && past due`, computed here so the table, the rail, the
 * aging strip and the reports cannot drift apart.
 *
 * Legacy `saved`: `draft` and `saved` were the same state everywhere in the app
 * except one place — `saved` pushed to the customer's external accounting system
 * and `draft` did not — so an autosaved, never-sent composer draft landed in the
 * customer's QuickBooks as receivable. `saved` is gone; `normalizeInvoiceStatus`
 * folds any surviving row into `draft` so reads are correct before and after the
 * backfill migration.
 */

/** Lifecycle states the server may store. */
export const INVOICE_LIFECYCLE_STATUSES = ["draft", "sent", "partial", "paid", "overdue", "void"] as const
export type InvoiceLifecycleStatus = (typeof INVOICE_LIFECYCLE_STATUSES)[number]

/** Includes the retired `saved`, which readers may still encounter until the backfill runs. */
export type StoredInvoiceStatus = InvoiceLifecycleStatus | "saved"

const LIFECYCLE_SET: ReadonlySet<string> = new Set(INVOICE_LIFECYCLE_STATUSES)

/**
 * Invoice lifecycle states that carry money owed by a customer — the open-AR set.
 * Excludes `paid` (settled) and `void` (cancelled) as well as `draft`, which is
 * not yet a receivable because nobody has billed it.
 */
export const OPEN_AR_INVOICE_STATUSES = ["sent", "partial", "overdue"] as const
export type OpenArInvoiceStatus = (typeof OPEN_AR_INVOICE_STATUSES)[number]

const OPEN_AR_SET: ReadonlySet<string> = new Set(OPEN_AR_INVOICE_STATUSES)

/** States from which an invoice can still be edited in place. */
const EDITABLE_SET: ReadonlySet<string> = new Set(["draft"])

/** Source types whose invoices are owned by their generator, not editable in place. */
export const SYSTEM_CONTROLLED_INVOICE_SOURCES = ["from_costs", "pay_application", "fee"] as const

const SYSTEM_CONTROLLED_SET: ReadonlySet<string> = new Set(SYSTEM_CONTROLLED_INVOICE_SOURCES)

/** Folds the retired `saved` into `draft` and rejects anything unrecognized. */
export function normalizeInvoiceStatus(status?: string | null): InvoiceLifecycleStatus {
  const value = String(status ?? "").toLowerCase()
  if (value === "saved") return "draft"
  return LIFECYCLE_SET.has(value) ? (value as InvoiceLifecycleStatus) : "draft"
}

export function isOpenArInvoiceStatus(status?: string | null): boolean {
  return OPEN_AR_SET.has(normalizeInvoiceStatus(status))
}

export function isEditableInvoiceStatus(status?: string | null): boolean {
  return EDITABLE_SET.has(normalizeInvoiceStatus(status))
}

export function isSystemControlledInvoiceSource(sourceType?: string | null): boolean {
  return SYSTEM_CONTROLLED_SET.has(String(sourceType ?? "manual"))
}

/** True once the invoice has been billed to the customer (issued or beyond). */
export function isIssuedInvoiceStatus(status?: string | null): boolean {
  const value = normalizeInvoiceStatus(status)
  return value !== "draft" && value !== "void"
}

/* ------------------------------------------------------------------------- *
 * Date-only arithmetic.
 *
 * `issue_date` and `due_date` are SQL `date` columns rendered as "yyyy-MM-dd".
 * They name a calendar day, not an instant, so every comparison here happens in
 * whole days on a UTC-anchored midnight. Parsing them into local `Date`s and
 * subtracting milliseconds — which is what the table, the rail and the aging
 * strip each used to do separately — is off by one across a daylight-saving
 * boundary, so an invoice could read "1d overdue" in one place and "due today"
 * in another on the same screen.
 * ------------------------------------------------------------------------- */

const DAY_MS = 86_400_000
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/

/** Midnight UTC for a "yyyy-MM-dd" string, or null when it isn't one. */
export function dateOnlyToUtcMs(value?: string | null): number | null {
  const match = DATE_ONLY.exec(String(value ?? ""))
  if (!match) return null
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(ms) ? null : ms
}

/** Today as midnight UTC of the viewer's calendar day. */
export function todayDateOnlyUtcMs(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Whole days a due date is in the past; 0 when it is today, in the future, or absent. */
export function daysPastDueOn(dueDate?: string | null, now?: Date): number {
  const due = dateOnlyToUtcMs(dueDate)
  if (due === null) return 0
  const diff = todayDateOnlyUtcMs(now) - due
  return diff > 0 ? Math.round(diff / DAY_MS) : 0
}

/** Whole days until a due date; negative once it is past. Null when there is no due date. */
export function daysUntilDueOn(dueDate?: string | null, now?: Date): number | null {
  const due = dateOnlyToUtcMs(dueDate)
  if (due === null) return null
  return Math.round((due - todayDateOnlyUtcMs(now)) / DAY_MS)
}

/** The one aging ladder: 1–30 / 31–60 / 61–90 / 90+. Null when not past due. */
export type AgingBucketIndex = 0 | 1 | 2 | 3
export const AGING_BUCKET_LABELS = ["1–30 days", "31–60 days", "61–90 days", "90+ days"] as const

export function agingBucketIndex(daysPastDue: number): AgingBucketIndex | null {
  if (daysPastDue <= 0) return null
  if (daysPastDue <= 30) return 0
  if (daysPastDue <= 60) return 1
  if (daysPastDue <= 90) return 2
  return 3
}

/* ------------------------------------------------------------------------- *
 * Derived display state.
 * ------------------------------------------------------------------------- */

export interface InvoiceLifecycleFacts {
  status?: string | null
  balanceCents?: number | null
  dueDate?: string | null
}

/**
 * The status a person should see. Adds `overdue` on top of the stored lifecycle
 * — and, critically, only for invoices that were actually billed: a draft with a
 * stale due date is not late, because nobody has asked anyone to pay it.
 */
export function deriveInvoiceDisplayStatus(facts: InvoiceLifecycleFacts, now?: Date): InvoiceLifecycleStatus {
  const base = normalizeInvoiceStatus(facts.status)
  if (base !== "sent" && base !== "partial" && base !== "overdue") return base
  const owed = (facts.balanceCents ?? 0) > 0
  if (!owed) return base === "overdue" ? "sent" : base
  return daysPastDueOn(facts.dueDate, now) > 0 ? "overdue" : base === "overdue" ? "sent" : base
}

/** Money still owed, counted only where money can be owed. */
export function openBalanceCents(facts: InvoiceLifecycleFacts, now?: Date): number {
  const status = deriveInvoiceDisplayStatus(facts, now)
  if (!OPEN_AR_SET.has(status)) return 0
  return Math.max(0, facts.balanceCents ?? 0)
}

/** Days past due, but only when the invoice is genuinely late. */
export function overdueDaysOf(facts: InvoiceLifecycleFacts, now?: Date): number {
  return deriveInvoiceDisplayStatus(facts, now) === "overdue" ? daysPastDueOn(facts.dueDate, now) : 0
}

export interface ArAgingTotals {
  outstandingCents: number
  overdueCents: number
  /** Balance past due by 1–30 / 31–60 / 61–90 / 90+ days. */
  buckets: [number, number, number, number]
}

export function emptyArAgingTotals(): ArAgingTotals {
  return { outstandingCents: 0, overdueCents: 0, buckets: [0, 0, 0, 0] }
}

/** Folds one invoice's facts into an aging accumulator. The only aging arithmetic. */
export function accumulateArAging(totals: ArAgingTotals, facts: InvoiceLifecycleFacts, now?: Date): ArAgingTotals {
  const balance = openBalanceCents(facts, now)
  if (balance <= 0) return totals
  totals.outstandingCents += balance
  const bucket = agingBucketIndex(daysPastDueOn(facts.dueDate, now))
  if (bucket === null) return totals
  totals.overdueCents += balance
  totals.buckets[bucket] += balance
  return totals
}

export function summarizeArAging(invoices: InvoiceLifecycleFacts[], now?: Date): ArAgingTotals {
  return invoices.reduce<ArAgingTotals>((totals, facts) => accumulateArAging(totals, facts, now), emptyArAgingTotals())
}
