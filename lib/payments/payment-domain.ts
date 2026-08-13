export const PAYMENT_RUN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "processing",
  "partially_paid",
  "paid",
  "partially_failed",
  "failed",
  "canceled",
] as const

export type PaymentRunStatus = (typeof PAYMENT_RUN_STATUSES)[number]

export const DISBURSEMENT_STATUSES = [
  "created",
  "submitted",
  "debit_pending",
  "funds_available",
  "transfer_pending",
  "payout_pending",
  "paid",
  "failed",
  "returned",
  "reversed",
  "canceled",
] as const

export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number]
export type PaymentApprovalMode = "sole" | "dual"

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function observedFixedHoliday(year: number, month: number, day: number) {
  const actual = new Date(Date.UTC(year, month, day))
  const observed = new Date(actual)
  if (actual.getUTCDay() === 6) observed.setUTCDate(observed.getUTCDate() - 1)
  if (actual.getUTCDay() === 0) observed.setUTCDate(observed.getUTCDate() + 1)
  return utcDateKey(observed)
}

function nthWeekday(year: number, month: number, weekday: number, occurrence: number) {
  const date = new Date(Date.UTC(year, month, 1))
  date.setUTCDate(1 + ((weekday - date.getUTCDay() + 7) % 7) + (occurrence - 1) * 7)
  return utcDateKey(date)
}

function lastWeekday(year: number, month: number, weekday: number) {
  const date = new Date(Date.UTC(year, month + 1, 0))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7))
  return utcDateKey(date)
}

const US_BANK_HOLIDAYS_BY_YEAR = new Map<number, Set<string>>()

function usBankHolidayKeys(year: number) {
  const cached = US_BANK_HOLIDAYS_BY_YEAR.get(year)
  if (cached) return cached
  const holidays = new Set([
    observedFixedHoliday(year, 0, 1),
    nthWeekday(year, 0, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 1, 1, 3), // Washington's Birthday
    lastWeekday(year, 4, 1), // Memorial Day
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 9, 1, 2), // Columbus Day
    observedFixedHoliday(year, 10, 11),
    nthWeekday(year, 10, 4, 4), // Thanksgiving
    observedFixedHoliday(year, 11, 25),
  ])
  US_BANK_HOLIDAYS_BY_YEAR.set(year, holidays)
  return holidays
}

function isUsBankBusinessDay(date: Date) {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const key = utcDateKey(date)
  // New Year's observed day can fall in the preceding calendar year, so check
  // adjacent holiday calendars as well as the date's own year.
  const year = date.getUTCFullYear()
  return ![year - 1, year, year + 1].some((candidate) => usBankHolidayKeys(candidate).has(key))
}

/** Add 24-hour US bank-business-day hours, excluding weekends and bank holidays. */
export function addBusinessHours(start: string | Date, hours: number): Date {
  if (!Number.isInteger(hours) || hours < 0) throw new Error("Business-hour hold must be a non-negative integer")
  const result = new Date(start)
  if (Number.isNaN(result.getTime())) throw new Error("Business-hour hold start is invalid")
  let remaining = hours
  while (remaining > 0) {
    result.setUTCHours(result.getUTCHours() + 1)
    if (isUsBankBusinessDay(result)) remaining -= 1
  }
  return result
}

/**
 * Runs are immutable after creation. There is no edit path and no return to
 * draft: a material change means cancel + rebuild, and a content-hash mismatch
 * at decide/execute rejects the stale copy. Every state after `draft` is only
 * reachable forward or into `canceled`.
 */
const PAYMENT_RUN_TRANSITIONS: Record<PaymentRunStatus, readonly PaymentRunStatus[]> = {
  draft: ["pending_approval", "canceled"],
  pending_approval: ["approved", "canceled"],
  approved: ["processing", "canceled"],
  processing: ["partially_paid", "paid", "partially_failed", "failed"],
  partially_paid: ["paid", "partially_failed"],
  paid: [],
  partially_failed: [],
  failed: [],
  canceled: [],
}

const DISBURSEMENT_TRANSITIONS: Record<DisbursementStatus, readonly DisbursementStatus[]> = {
  created: ["submitted", "failed", "canceled"],
  submitted: ["debit_pending", "funds_available", "failed", "canceled"],
  debit_pending: ["funds_available", "failed", "canceled"],
  funds_available: ["transfer_pending", "payout_pending", "returned", "reversed"],
  transfer_pending: ["payout_pending", "paid", "failed", "returned", "reversed"],
  payout_pending: ["paid", "failed", "returned", "reversed"],
  paid: ["returned", "reversed"],
  failed: [],
  returned: [],
  reversed: [],
  canceled: [],
}

function assertKnownStatus<T extends string>(status: string, statuses: readonly T[], label: string): asserts status is T {
  if (!statuses.some((candidate) => candidate === status)) {
    throw new Error(`Unknown ${label} status: ${status}`)
  }
}

export function assertPaymentRunTransition(from: string, to: string) {
  assertKnownStatus(from, PAYMENT_RUN_STATUSES, "payment run")
  assertKnownStatus(to, PAYMENT_RUN_STATUSES, "payment run")
  if (!PAYMENT_RUN_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid payment run transition: ${from} -> ${to}`)
  }
}

export function assertDisbursementTransition(from: string, to: string) {
  assertKnownStatus(from, DISBURSEMENT_STATUSES, "disbursement")
  assertKnownStatus(to, DISBURSEMENT_STATUSES, "disbursement")
  if (!DISBURSEMENT_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid disbursement transition: ${from} -> ${to}`)
  }
}

export function canTransitionDisbursement(from: DisbursementStatus, to: DisbursementStatus) {
  return DISBURSEMENT_TRANSITIONS[from].includes(to)
}

export function requiredApprovalCount(mode: PaymentApprovalMode) {
  return mode === "dual" ? 2 : 1
}

/**
 * A run freezes the owner's self-approval choice inside its control snapshot.
 * Reading the live policy would retroactively weaken or strand a submitted
 * payment when an administrator changes the setting later.
 */
export function requesterMayApprovePaymentRun(controlSnapshot: unknown) {
  if (!controlSnapshot || typeof controlSnapshot !== "object" || Array.isArray(controlSnapshot)) return false
  const policy = Reflect.get(controlSnapshot, "policy")
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false
  return Reflect.get(policy, "requester_may_approve") === true
}

/**
 * The one-way order a disbursement walks. Terminal states are not on it — they
 * are reachable from several points and are handled by the transition table.
 */
export const DISBURSEMENT_FORWARD_PATH: readonly DisbursementStatus[] = [
  "created",
  "submitted",
  "debit_pending",
  "funds_available",
  "transfer_pending",
  "payout_pending",
  "paid",
]

const UNPAID_TERMINAL_STATUSES = ["failed", "returned", "canceled"] as const
export type UnpaidTerminalStatus = (typeof UNPAID_TERMINAL_STATUSES)[number]

function isUnpaidTerminal(status: string): status is UnpaidTerminalStatus {
  return (UNPAID_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * The statuses a disbursement must pass through to reach `target`, in order.
 *
 * Empty means "do nothing", which is the answer for every duplicate and every
 * out-of-order webhook: the provider re-delivers, and events routinely arrive
 * after a later one has already been processed. Both must be no-ops rather than
 * walking a state backwards.
 *
 * A disbursement that has already reached a terminal state never moves again —
 * a late `payout.paid` arriving after a return must not resurrect the payment.
 */
export function planDisbursementAdvance(current: string, target: string): DisbursementStatus[] {
  assertKnownStatus(current, DISBURSEMENT_STATUSES, "disbursement")
  assertKnownStatus(target, DISBURSEMENT_STATUSES, "disbursement")
  if (current === target) return []
  if (isUnpaidTerminal(current) || current === "reversed") return []
  const currentIndex = DISBURSEMENT_FORWARD_PATH.indexOf(current)
  const targetIndex = DISBURSEMENT_FORWARD_PATH.indexOf(target)
  // Already at or past the target on the forward path: a stale event.
  if (targetIndex >= 0 && currentIndex >= targetIndex) return []
  if (targetIndex >= 0 && currentIndex >= 0) return [...DISBURSEMENT_FORWARD_PATH.slice(currentIndex + 1, targetIndex + 1)]

  // A terminal target is not on the forward path and is not reachable from every
  // point on it — `created -> returned` is not a legal hop. Walk forward to the
  // first state the target IS reachable from, then apply it. Doing this here
  // rather than in the caller means no call site has to know that a return
  // arriving before settlement has to pass through funds_available first.
  if (currentIndex >= 0) {
    for (let index = currentIndex; index < DISBURSEMENT_FORWARD_PATH.length; index += 1) {
      if (!canTransitionDisbursement(DISBURSEMENT_FORWARD_PATH[index], target as DisbursementStatus)) continue
      return [...DISBURSEMENT_FORWARD_PATH.slice(currentIndex + 1, index + 1), target as DisbursementStatus]
    }
    // Unreachable without an illegal hop — cancelling after funds are available,
    // for instance. Emitting nothing is the only safe answer.
    return []
  }
  return canTransitionDisbursement(current, target as DisbursementStatus) ? [target as DisbursementStatus] : []
}

/**
 * A run item's status given its payees'.
 *
 * `terminalTarget` is the terminal state being applied to the payee that just
 * changed, so an item whose payees have all failed reports the same reason.
 *
 * An item with no payees reports `processing`, never `paid`. `[].every()` is
 * true, so the natural phrasing concludes "paid" from an absence of evidence and
 * closes a bill nobody paid. In a money system the safe default is to stay open
 * and let a human notice.
 */
export function resolveRunItemStatus(payeeStatuses: readonly string[], terminalTarget: UnpaidTerminalStatus): string {
  if (payeeStatuses.length === 0) return "processing"
  if (payeeStatuses.every((status) => status === "paid")) return "paid"
  if (payeeStatuses.some((status) => status === "paid")) return "partially_paid"
  if (payeeStatuses.every(isUnpaidTerminal)) return terminalTarget
  return "processing"
}

/** A run's status given its items'. Same empty-set reasoning as the item rollup. */
export function resolveRunStatus(itemStatuses: readonly string[]): string {
  if (itemStatuses.length === 0) return "processing"
  const anySettled = itemStatuses.some((status) => status === "paid" || status === "partially_paid")
  const anyFailed = itemStatuses.some(isUnpaidTerminal)
  if (itemStatuses.every((status) => status === "paid")) return "paid"
  if (anySettled && anyFailed) return "partially_failed"
  if (itemStatuses.every(isUnpaidTerminal)) return "failed"
  if (anySettled) return "partially_paid"
  return "processing"
}

export interface LedgerEntryInput {
  accountCode: string
  direction: "debit" | "credit"
  amountCents: number
  currency: string
}

export function assertBalancedLedgerEntries(entries: LedgerEntryInput[]) {
  if (entries.length < 2) {
    throw new Error("A ledger transaction requires at least two entries")
  }
  const currencies = new Set(entries.map((entry) => entry.currency.toLowerCase()))
  if (currencies.size !== 1) {
    throw new Error("Ledger entries must use one currency")
  }
  let debits = 0
  let credits = 0
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new Error("Ledger entry amount must be a positive integer number of cents")
    }
    if (entry.direction === "debit") debits += entry.amountCents
    else credits += entry.amountCents
  }
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits) || debits !== credits) {
    throw new Error(`Ledger is out of balance: debits=${debits}, credits=${credits}`)
  }
  return { debits, credits, currency: [...currencies][0] }
}

export function assertIntegerCents(value: number, label: string, options: { allowZero?: boolean } = {}) {
  if (!Number.isSafeInteger(value) || (options.allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${options.allowZero ? "a non-negative" : "a positive"} integer number of cents`)
  }
  return value
}
