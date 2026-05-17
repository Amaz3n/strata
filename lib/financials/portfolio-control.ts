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
