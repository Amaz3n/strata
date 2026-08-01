import { createHash } from "node:crypto"

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

const PAYMENT_RUN_TRANSITIONS: Record<PaymentRunStatus, readonly PaymentRunStatus[]> = {
  draft: ["pending_approval", "canceled"],
  pending_approval: ["draft", "approved", "canceled"],
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

export function requiredApprovalCount(mode: PaymentApprovalMode) {
  return mode === "dual" ? 2 : 1
}

export function assertApprovalQuorum(input: {
  mode: PaymentApprovalMode
  requesterId: string
  approvals: Array<{ approverId: string; decision: "approved" | "rejected" }>
}) {
  if (input.approvals.some((approval) => approval.approverId === input.requesterId)) {
    throw new Error("Payment run requester cannot approve their own run")
  }
  if (input.approvals.some((approval) => approval.decision === "rejected")) {
    throw new Error("Payment run has been rejected")
  }
  const distinctApprovers = new Set(
    input.approvals.filter((approval) => approval.decision === "approved").map((approval) => approval.approverId),
  )
  const required = requiredApprovalCount(input.mode)
  if (distinctApprovers.size < required) {
    throw new Error(`Payment run requires ${required} distinct approval${required === 1 ? "" : "s"}`)
  }
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  )
}

export function createPaymentRunContentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")
}

export function assertIntegerCents(value: number, label: string, options: { allowZero?: boolean } = {}) {
  if (!Number.isSafeInteger(value) || (options.allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${options.allowZero ? "a non-negative" : "a positive"} integer number of cents`)
  }
  return value
}
