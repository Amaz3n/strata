import { AlertTriangle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDay, payableStatusTone } from "@/components/payables/payables-ui"
import { isVendorCredit } from "@/lib/financials/payables-rules"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { ComplianceRules, ComplianceStatusSummary } from "@/lib/types"
import { cn } from "@/lib/utils"

export function payableReleaseWarnings(
  bill: VendorBillSummary,
  complianceRules: ComplianceRules,
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>,
): string[] {
  if (bill.is_draft || isVendorCredit(bill) || bill.status === "paid") return []
  const warnings: string[] = []
  const compliance = bill.company_id ? complianceStatusByCompanyId[bill.company_id] : undefined
  if (compliance && !compliance.is_compliant) {
    warnings.push(compliance.expired.length > 0
      ? "Vendor compliance documents have expired"
      : "Vendor is missing required compliance documents")
  }
  if (complianceRules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    warnings.push("Lien waiver not received")
  }
  if (bill.over_budget) warnings.push("Exceeds the linked commitment")
  return warnings
}

export function PayableReleaseWarning({ warnings }: { warnings: string[] }) {
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <span className="shrink-0 leading-none" onClick={(event) => event.stopPropagation()}>
          <AlertTriangle className="size-3.5 text-warning" />
          <span className="sr-only">May block payment: {warnings.join("; ")}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        <p className="font-medium">May block payment</p>
        <ul className="mt-1 space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5 text-muted-foreground">
              <span aria-hidden>·</span><span>{warning}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function PayableReadinessDot({ readiness }: { readiness: CompanyPaymentReadinessStatus | undefined }) {
  if (readiness === "ready") return null
  const label = readiness === "verifying"
    ? "Vendor is verifying their bank account — ACH is not available yet"
    : readiness === "invited"
      ? "Vendor was invited to set up ACH but has not finished"
      : readiness === "suspended"
        ? "Vendor's Arc Pay access is suspended"
        : readiness === "revoked"
          ? "Vendor's Arc Pay access was revoked"
          : "Vendor cannot be paid by ACH yet — invite them from the payable"
  return (
    <span title={label} className={cn("size-1.5 shrink-0 rounded-full", readiness === "verifying" ? "bg-muted-foreground" : "bg-warning")}>
      <span className="sr-only">{label}</span>
    </span>
  )
}

export function payableOperationalStatus(
  bill: VendorBillSummary,
  membership?: PayableRunMembership,
  awaitsViewer = false,
) {
  if (isVendorCredit(bill)) return { label: "Credit", className: "border-border text-muted-foreground" }
  if (membership) {
    return {
      label: awaitsViewer
        ? "Awaiting your approval"
        : membership.runStatus === "pending_approval"
          ? "In approval"
          : membership.runStatus === "processing" || membership.runStatus === "partially_paid"
            ? membership.stage
            : membership.scheduledFor
              ? `Sends ${formatDay(membership.scheduledFor)}`
              : "Scheduled",
      className: awaitsViewer
        ? "border-primary/40 bg-primary/10 text-primary"
        : "border-primary/25 bg-primary/5 text-primary",
    }
  }
  return payableStatusTone(bill.status, bill.is_draft)
}

export function PayableOperationalStatus({
  bill,
  membership,
  awaitsViewer = false,
}: {
  bill: VendorBillSummary
  membership?: PayableRunMembership
  awaitsViewer?: boolean
}) {
  const tone = payableOperationalStatus(bill, membership, awaitsViewer)
  return <Badge variant="outline" title={tone.label} className={cn("max-w-full truncate font-normal", tone.className)}>{tone.label}</Badge>
}

export function payableDeleteBlockedReason(bill: VendorBillSummary, membership?: PayableRunMembership): string | null {
  if (membership) return "it belongs to an active payment run"
  if (bill.status === "paid" || bill.status === "partial" || (bill.paid_cents ?? 0) > 0) return "it has recorded payments"
  if (bill.qbo_id) return "it exists in the accounting file"
  return null
}
