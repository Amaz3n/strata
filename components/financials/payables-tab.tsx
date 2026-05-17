"use client"

import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { ProjectPayablesClient } from "@/components/payables/project-payables-client"
import { AlertTriangle } from "lucide-react"

interface PayablesTabProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  loadErrors?: string[]
}

export function PayablesTab({
  projectId,
  vendorBills,
  costCodes,
  complianceRules,
  complianceStatusByCompanyId,
  loadErrors = [],
}: PayablesTabProps) {
  return (
    <div className="w-full">
      {loadErrors.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Some payable data could not load.</p>
              <p className="mt-1 text-amber-800">{loadErrors.join(" · ")}</p>
            </div>
          </div>
        </div>
      ) : null}
      <ProjectPayablesClient
        projectId={projectId}
        vendorBills={vendorBills}
        costCodes={costCodes}
        complianceRules={complianceRules}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        fullBleed
      />
    </div>
  )
}
