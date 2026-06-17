/**
 * Trust Center & Reconciliation — Shared Types
 *
 * Used by the project-level Trust Center page.  Each exception type maps to
 * one of the queues defined in §5.8 of the financials gameplan.
 */

export type TrustCenterExceptionKind =
  | "approved_unbilled"           // Approved but unbilled costs
  | "billed_without_proof"        // Costs billed without proof
  | "billable_no_job_cost"        // Billable costs not reflected in job-cost actuals
  | "job_cost_unclassified"       // Job-cost actuals not classified billable/non-billable
  | "bill_no_commitment"          // Vendor bills not tied to commitments
  | "payment_unlinked"            // Payments not tied to invoices/bills
  | "qbo_sync_error"              // QBO sync errors
  | "budget_actual_mismatch"      // Budget actuals mismatch job-cost ledger
  | "retainage_mismatch"          // Retainage mismatch
  | "invoice_total_mismatch"      // Invoice totals mismatch line totals
  | "cash_risk_ap_before_ar"      // AP due before AR collected — cash risk
  | "cost_paid_not_billed"        // Costs paid to vendors but not yet billed to owner
  | "cost_billed_owner_unpaid"    // Costs billed to owner but unpaid

export type TrustCenterSeverity = "info" | "warning" | "critical"

export interface TrustCenterException {
  id: string
  kind: TrustCenterExceptionKind
  severity: TrustCenterSeverity
  project_id?: string | null
  project_name?: string | null
  reference: string
  description: string
  amount_cents: number
  source_type?: string | null
  source_id?: string | null
  href: string
  metadata?: Record<string, unknown>
}

export interface TrustCenterQueueSummary {
  kind: TrustCenterExceptionKind
  label: string
  count: number
  total_cents: number
  severity: TrustCenterSeverity
}

export interface ProjectTrustCenterData {
  project_id: string
  queues: TrustCenterQueueSummary[]
  exceptions: TrustCenterException[]
  total_exception_count: number
  critical_count: number
  warning_count: number
  info_count: number
  is_clean: boolean
  generated_at: string
}

export const TRUST_CENTER_QUEUE_LABELS: Record<TrustCenterExceptionKind, string> = {
  approved_unbilled: "Approved But Unbilled",
  billed_without_proof: "Billed Without Proof",
  billable_no_job_cost: "Billable Missing Job Cost",
  job_cost_unclassified: "Job Cost Unclassified",
  bill_no_commitment: "Bills Without Commitment",
  payment_unlinked: "Unlinked Payments",
  qbo_sync_error: "QBO Sync Errors",
  budget_actual_mismatch: "Budget/Actuals Mismatch",
  retainage_mismatch: "Retainage Mismatch",
  invoice_total_mismatch: "Invoice Total Mismatch",
  cash_risk_ap_before_ar: "AP Due Before AR",
  cost_paid_not_billed: "Paid But Not Billed",
  cost_billed_owner_unpaid: "Billed But Owner Unpaid",
}

export const TRUST_CENTER_QUEUE_ORDER: TrustCenterExceptionKind[] = [
  "invoice_total_mismatch",
  "budget_actual_mismatch",
  "billable_no_job_cost",
  "approved_unbilled",
  "billed_without_proof",
  "bill_no_commitment",
  "payment_unlinked",
  "retainage_mismatch",
  "qbo_sync_error",
  "job_cost_unclassified",
  "cash_risk_ap_before_ar",
  "cost_paid_not_billed",
  "cost_billed_owner_unpaid",
]
