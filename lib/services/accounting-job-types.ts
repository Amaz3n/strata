/**
 * Outbox job types for accounting pushes. The legacy qbo_sync_* names are no longer
 * enqueued anywhere; they stay listed so the outbox worker and diagnostics keep
 * draining/counting jobs enqueued before the rename. Remove once the queue is
 * confirmed empty of them.
 */
export const LEGACY_ACCOUNTING_JOB_TYPES = [
  "qbo_sync_invoice", "qbo_sync_payment", "qbo_sync_project_expense", "qbo_sync_vendor_bill", "qbo_sync_bill_payment",
] as const

export const ACCOUNTING_JOB_TYPES = [
  "accounting_push_invoice", "accounting_push_payment", "accounting_push_project_expense", "accounting_push_vendor_bill", "accounting_push_bill_payment",
  ...LEGACY_ACCOUNTING_JOB_TYPES,
] as const
