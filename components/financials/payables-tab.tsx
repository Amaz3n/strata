"use client"

import type { BudgetLineOption, ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { ProjectPayablesClient } from "@/components/payables/project-payables-client"
import { AlertTriangle } from "lucide-react"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"

type ProjectBillingModel = "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"

interface PayablesTabProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  selectedBill?: VendorBillSummary | null
  costCodes: CostCode[]
  budgetLines?: BudgetLineOption[]
  costCodesEnabled?: boolean
  billingModel: ProjectBillingModel
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  loadErrors?: string[]
  holdEvaluations?: Record<string, PaymentHoldEvaluation>
  railOpen?: boolean
  paymentReadinessByCompanyId?: Record<string, CompanyPaymentReadinessStatus>
  runMembershipByBillId?: Record<string, PayableRunMembership>
  viewerMayApproveRuns?: boolean
  approvalViewer?: {
    userId: string
    approvers: Array<{ userId: string; name: string }>
  } | null
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  queueTotals: Record<string, { count: number; amountCents: number }>
  summaryTruncated?: boolean
  initialQueue: string
  initialDue: string
  initialSearch: string
}

export function PayablesTab({
  projectId,
  vendorBills,
  selectedBill = null,
  costCodes,
  budgetLines = [],
  costCodesEnabled = true,
  billingModel,
  complianceRules,
  complianceStatusByCompanyId,
  loadErrors = [],
  holdEvaluations = {},
  railOpen = false,
  paymentReadinessByCompanyId = {},
  runMembershipByBillId = {},
  viewerMayApproveRuns = false,
  approvalViewer = null,
  pagination,
  queueTotals,
  summaryTruncated = false,
  initialQueue,
  initialDue,
  initialSearch,
}: PayablesTabProps) {
  return (
    <div className="w-full">
      {loadErrors.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">Some payable data could not load.</span>
              <span className="text-amber-800/40 dark:text-amber-400/30">•</span>
              <span className="text-amber-800 dark:text-amber-300">{loadErrors.join(" · ")}</span>
            </div>
          </div>
        </div>
      ) : null}
      <ProjectPayablesClient
        projectId={projectId}
        vendorBills={vendorBills}
        selectedBill={selectedBill}
        costCodes={costCodesEnabled ? costCodes : []}
        budgetLines={budgetLines}
        costCodesEnabled={costCodesEnabled}
        billingModel={billingModel}
        complianceRules={complianceRules}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        fullBleed
        holdEvaluations={holdEvaluations}
        railOpen={railOpen}
        paymentReadinessByCompanyId={paymentReadinessByCompanyId}
        runMembershipByBillId={runMembershipByBillId}
        viewerMayApproveRuns={viewerMayApproveRuns}
        approvalViewer={approvalViewer}
        pagination={pagination}
        queueTotals={queueTotals}
        summaryTruncated={summaryTruncated}
        initialQueue={initialQueue}
        initialDue={initialDue}
        initialSearch={initialSearch}
      />
    </div>
  )
}
