/**
 * The lifecycle language shared by the organization desk and each project's
 * payables workbench. URL parsing lives here so a stale or legacy query never
 * broadens a financial list by accident.
 */
export const PAYABLE_QUEUES = [
  "drafts",
  "approval",
  "ready",
  "inflight",
  "paid",
  "all",
] as const

export type PayableQueue = (typeof PAYABLE_QUEUES)[number]

export const PAYABLE_QUEUE_LABELS: Record<PayableQueue, string> = {
  drafts: "Drafts",
  approval: "Needs approval",
  ready: "Ready to pay",
  inflight: "In flight",
  paid: "Paid",
  all: "All",
}

export const PAYABLE_DUE_FILTERS = ["any", "overdue", "due_soon"] as const
export type PayableDueFilter = (typeof PAYABLE_DUE_FILTERS)[number]

/** Payment-run item states that claim a bill for the In flight queue. */
export const ACTIVE_PAYABLE_RUN_ITEM_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "processing",
  "partially_paid",
] as const

export function parsePayableQueue(value: unknown, fallback: PayableQueue = "approval"): PayableQueue {
  if (value === "needs_review") return "approval"
  if (value === "payable") return "ready"
  return PAYABLE_QUEUES.includes(value as PayableQueue) ? (value as PayableQueue) : fallback
}

export function parsePayableDueFilter(value: unknown): PayableDueFilter {
  return PAYABLE_DUE_FILTERS.includes(value as PayableDueFilter) ? (value as PayableDueFilter) : "any"
}

/**
 * Old project links encoded urgency as a queue. Preserve those links while
 * keeping urgency independent for every newly written URL.
 */
export function parseProjectPayablesQuery(input: { queue?: unknown; due?: unknown }) {
  const legacyDue = input.queue === "overdue" || input.queue === "due_soon" ? input.queue : null
  return {
    queue: parsePayableQueue(legacyDue ? undefined : input.queue),
    due: parsePayableDueFilter(input.due ?? legacyDue),
  }
}
