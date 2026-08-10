"use client"

import * as React from "react"
import { toast } from "sonner"

import { decidePaymentRiskReviewAction } from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { BlockedPaymentRun } from "@/lib/services/payment-risk"

/**
 * Payments an automated risk control stopped.
 *
 * It announces itself instead of waiting to be found: on a normal day there is
 * nothing here and the strip does not render at all, which is what makes it
 * impossible to miss on the day there is. That is the same reason it is not a
 * tab or a page — a surface whose healthy state is empty should never occupy
 * space on a desk people work in all day.
 */
export function BlockedPaymentsStrip({
  blockedRuns,
  onDecided,
}: {
  blockedRuns: BlockedPaymentRun[]
  onDecided: () => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const [reasons, setReasons] = React.useState<Record<string, string>>({})
  const [pending, setPending] = React.useState(false)

  if (blockedRuns.length === 0) return null

  const totalCents = blockedRuns.reduce((sum, run) => sum + run.totalDebitCents, 0)

  const decide = async (runId: string, decision: "allow" | "block") => {
    const reason = (reasons[runId] ?? "").trim()
    if (reason.length < 12) {
      toast.error("Say what you verified, in at least a dozen characters")
      return
    }
    setPending(true)
    try {
      const result = await decidePaymentRiskReviewAction({ run_id: runId, decision, reason })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(decision === "allow" ? "Risk block cleared" : "Risk block confirmed")
      setReasons((current) => ({ ...current, [runId]: "" }))
      onDecided()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="border-b border-destructive/30 bg-destructive/5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs sm:px-6"
      >
        <span className="font-medium text-destructive">
          {blockedRuns.length} {blockedRuns.length === 1 ? "payment is" : "payments are"} blocked by risk controls
        </span>
        <span className="tabular-nums text-muted-foreground">{formatMoneyFromCents(totalCents)}</span>
        <span className="ml-auto text-muted-foreground underline">{expanded ? "Hide" : "Review"}</span>
      </button>

      {expanded ? (
        <div className="divide-y divide-destructive/20 border-t border-destructive/20">
          {blockedRuns.map((blocked) => (
            <div key={blocked.reviewId} className="px-4 py-3 sm:px-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="text-xs">
                  <span className="font-mono text-sm font-medium tabular-nums">
                    {formatMoneyFromCents(blocked.totalDebitCents)}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {blocked.paymentCount} {blocked.paymentCount === 1 ? "bill" : "bills"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {blocked.signals
                    .filter((signal) => signal.severity === "block")
                    .map((signal) => (
                      <span
                        key={signal.code}
                        className="border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
                      >
                        {signal.code.replaceAll("_", " ")}
                      </span>
                    ))}
                </div>
              </div>
              {blocked.preparedByViewer ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  You prepared this payment, so someone else has to decide it.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    value={reasons[blocked.runId] ?? ""}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [blocked.runId]: event.target.value }))
                    }
                    placeholder="What did you verify? (required)"
                    aria-label="Risk decision reason"
                    className="h-8 max-w-md text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={pending}
                    onClick={() => void decide(blocked.runId, "allow")}
                  >
                    Release
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    disabled={pending}
                    onClick={() => void decide(blocked.runId, "block")}
                  >
                    Keep blocked
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
