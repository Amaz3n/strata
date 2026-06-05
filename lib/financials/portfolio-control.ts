export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus"

export const agingBuckets: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "90_plus"]

export interface PortfolioFinancialSummary {
  ar_open_cents: number
  ar_overdue_cents: number
  ap_open_cents: number
  ap_due_soon_cents: number
  ready_to_invoice_cents: number
  blocked_payment_cents: number
  qbo_exception_count: number
  cash_flow_30_day_cents: number
}

export interface PortfolioFinancialRow {
  id: string
  kind: "ar" | "ap" | "ready_to_invoice" | "blocked" | "qbo"
  project_id?: string | null
  project_name?: string | null
  counterparty?: string | null
  reference: string
  status: string
  amount_cents: number
  due_date?: string | null
  age_days?: number | null
  aging_bucket?: AgingBucket
  reason?: string | null
  href: string
}

export interface PortfolioFinancialControlData {
  summary: PortfolioFinancialSummary
  arRows: PortfolioFinancialRow[]
  apRows: PortfolioFinancialRow[]
  readyToInvoiceRows: PortfolioFinancialRow[]
  blockedRows: PortfolioFinancialRow[]
  qboRows: PortfolioFinancialRow[]
  aging: {
    ar: Record<AgingBucket, number>
    ap: Record<AgingBucket, number>
  }
}

export type QBOSyncAttentionStatus = "error" | "failed" | "pending" | "needs_review"

export function qboSyncStatusNeedsAttention(status?: string | null): status is QBOSyncAttentionStatus {
  return status === "error" || status === "failed" || status === "pending" || status === "needs_review"
}

export function resolveLocalFinancialTruthAmount(params: {
  balance_due_cents?: number | null
  total_cents?: number | null
  paid_cents?: number | null
}) {
  if (params.balance_due_cents != null) return Math.max(0, Number(params.balance_due_cents))
  return Math.max(0, Number(params.total_cents ?? 0) - Number(params.paid_cents ?? 0))
}

export function qboSyncAttentionReason(status?: string | null, entityLabel = "Sync") {
  if (status === "pending") return `${entityLabel} sync pending`
  if (status === "needs_review") return `${entityLabel} needs accounting review`
  return `${entityLabel} sync failed`
}
