"use client"

import { Check, ShieldCheck } from "lucide-react"

import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { PaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { cn } from "@/lib/utils"

/**
 * Confirms who should receive the payment approval request. This is deliberately
 * not an activity timeline: no activity has happened while a bill is being
 * created. The choices come only from the org's controlled approver roster.
 */
export function PayableApprovalRoute({
  channel,
  externalMethod,
  routing,
  amountCents,
  requiredApprovals,
  requesterMayApprove,
  unavailableReason,
  selectedApproverIds,
  onSelectedApproverIdsChange,
}: {
  channel: "arc" | "external"
  externalMethod: string
  routing: PaymentApprovalRouting | null
  amountCents: number
  requiredApprovals: number
  requesterMayApprove: boolean
  unavailableReason?: string | null
  selectedApproverIds: string[]
  onSelectedApproverIdsChange: (ids: string[]) => void
}) {
  if (channel === "external") {
    return (
      <div className="flex items-start gap-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">Payable approval still applies</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Arc records that the obligation was approved; the {externalMethod} payment is recorded separately after it leaves your bank.
          </p>
        </div>
      </div>
    )
  }

  if (unavailableReason) {
    return <p className="text-xs text-muted-foreground">{unavailableReason}</p>
  }

  const eligible = (routing?.approvers ?? []).filter(
    (approver) => approver.permitted && (requesterMayApprove || approver.userId !== routing?.viewerUserId),
  )
  if (!routing?.rosterConfigured || eligible.length === 0) {
    return (
      <div className="flex items-start gap-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">Any permitted payment approver</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {requesterMayApprove
              ? "Your organization permits an authorized owner to approve a payment they prepared."
              : "Your organization has not narrowed payment approvals to a named roster. The preparer cannot approve their own payment."}
          </p>
        </div>
      </div>
    )
  }

  const toggle = (userId: string) => {
    onSelectedApproverIdsChange(
      selectedApproverIds.includes(userId)
        ? selectedApproverIds.filter((id) => id !== userId)
        : [...selectedApproverIds, userId],
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Confirm payment approvers</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose who should receive this bill’s payment approval request. Policy requires {requiredApprovals} distinct {requiredApprovals === 1 ? "approval" : "approvals"}.
          {requesterMayApprove ? " The preparer may be selected." : null}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {eligible.map((approver) => {
          const selected = selectedApproverIds.includes(approver.userId)
          const overLimit = approver.approvalLimitCents != null && amountCents > approver.approvalLimitCents
          return (
            <button
              key={approver.userId}
              type="button"
              aria-pressed={selected}
              disabled={overLimit}
              onClick={() => toggle(approver.userId)}
              className={cn(
                "flex min-h-14 items-center gap-3 border px-3 py-2 text-left transition-colors",
                selected ? "border-primary/45 bg-primary/10" : "hover:bg-muted/30",
                overLimit && "cursor-not-allowed opacity-50",
              )}
            >
              <span className={cn(
                "flex size-5 shrink-0 items-center justify-center border",
                selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
              )}>
                {selected ? <Check className="size-3.5" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{approver.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {overLimit
                    ? `Limit ${formatMoneyFromCents(approver.approvalLimitCents ?? 0)}`
                    : approver.approvalLimitCents != null
                      ? `Can approve up to ${formatMoneyFromCents(approver.approvalLimitCents)}`
                      : "No personal approval limit"}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {selectedApproverIds.length < requiredApprovals ? (
        <p className="text-xs text-warning">
          Select at least {requiredApprovals} available {requiredApprovals === 1 ? "approver" : "approvers"}.
        </p>
      ) : null}
    </div>
  )
}
