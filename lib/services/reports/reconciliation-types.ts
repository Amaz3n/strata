export type ReconciliationExceptionKind =
  | "invoice_total_mismatch"
  | "budget_actual_mismatch"
  | "incurred_billable_tieout"
  | "billable_no_job_cost"
  | "job_cost_unclassified"
  | "billed_without_proof"
  | "payment_unlinked"
  | "retainage_mismatch"

export type ReconciliationSeverity = "info" | "warning" | "critical"

export interface ReconciliationException {
  id: string
  kind: ReconciliationExceptionKind
  severity: ReconciliationSeverity
  project_id: string
  reference: string
  description: string
  amount_cents: number
  source_type?: string | null
  source_id?: string | null
  href: string
  metadata?: Record<string, unknown>
}

export interface ReconciliationQueueSummary {
  kind: ReconciliationExceptionKind
  label: string
  count: number
  total_cents: number
  severity: ReconciliationSeverity
}

export interface ProjectReconciliationReport {
  project_id: string
  queues: ReconciliationQueueSummary[]
  exceptions: ReconciliationException[]
  total_exception_count: number
  critical_count: number
  warning_count: number
  info_count: number
  is_clean: boolean
  failed_checks: string[]
  generated_at: string
}

export const RECONCILIATION_QUEUE_LABELS: Record<ReconciliationExceptionKind, string> = {
  invoice_total_mismatch: "Invoice Total Mismatch",
  budget_actual_mismatch: "Budget/Actuals Mismatch",
  incurred_billable_tieout: "Incurred/Billable Tie-Out",
  billable_no_job_cost: "Billable Missing Job Cost",
  job_cost_unclassified: "Job Cost Unclassified",
  billed_without_proof: "Billed Without Proof",
  payment_unlinked: "Unlinked Payments",
  retainage_mismatch: "Retainage Mismatch",
}

export const RECONCILIATION_QUEUE_ORDER: ReconciliationExceptionKind[] = [
  "invoice_total_mismatch",
  "budget_actual_mismatch",
  "incurred_billable_tieout",
  "billable_no_job_cost",
  "billed_without_proof",
  "payment_unlinked",
  "retainage_mismatch",
  "job_cost_unclassified",
]
