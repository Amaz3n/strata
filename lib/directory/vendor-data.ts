import type { ComplianceStatusSummary } from "@/lib/types"
import type { PrequalificationGlance } from "@/lib/services/prequalification"
import type { CompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations"

/**
 * Non-critical company decoration streamed after the directory rows. Keeping
 * this serializable type outside a server module lets the RSC hand its promise
 * directly to small client Suspense consumers.
 */
export interface DirectoryVendorData {
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  prequalificationByCompanyId: Record<string, PrequalificationGlance>
  complianceWatchCompanies: Array<{ id: string; name: string }>
  complianceWatchTruncated: boolean
  complianceWatchTotal: number
  statusUnavailable: boolean
}

/** Header badges arrive after party identity and never block account navigation. */
export interface DirectoryVendorHeaderSignals {
  overdueCents: number
  overdueBillCount: number
  complianceReady: boolean | null
  complianceMissing: number
  complianceExpired: number
  complianceExpiringSoon: number
  w9Status: "ready" | "missing" | "pending_review" | "rejected" | "not_required" | null
  w9NeedsAction: boolean
  paymentStatus: CompanyPaymentReadiness["status"] | null
  prequalificationStatus: PrequalificationGlance["status"] | null
}
