"use client"

import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { ProjectPayablesClient } from "@/components/payables/project-payables-client"
import { AlertTriangle } from "lucide-react"

interface PayablesTabProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  costCodesEnabled?: boolean
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  loadErrors?: string[]
}

export function PayablesTab({
  projectId,
  vendorBills,
  costCodes,
  costCodesEnabled = true,
  complianceRules,
  complianceStatusByCompanyId,
  loadErrors = [],
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
        costCodes={costCodesEnabled ? costCodes : []}
        costCodesEnabled={costCodesEnabled}
        complianceRules={complianceRules}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        fullBleed
      />
    </div>
  )
}
