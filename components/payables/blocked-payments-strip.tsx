"use client"

import * as React from "react"
import { toast } from "sonner"

import { decidePaymentRiskReviewAction } from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [sharedReason, setSharedReason] = React.useState("")

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

  const decideSelected = async (decision: "allow" | "block") => {
    if (sharedReason.trim().length < 12) return toast.error("Say what you verified, in at least a dozen characters")
    setPending(true)
    const results = await Promise.all([...selected].map((run_id) => decidePaymentRiskReviewAction({ run_id, decision, reason: sharedReason.trim() })))
    setPending(false)
    const failed = results.filter((result) => !result.success).length
    if (failed) toast.error(`${failed} risk decisions could not be recorded`)
    else { toast.success(`${results.length} risk decisions recorded`); setSelected(new Set()); setSharedReason(""); onDecided() }
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
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-6"><Checkbox checked={selected.size === blockedRuns.length} onCheckedChange={(checked) => setSelected(checked ? new Set(blockedRuns.filter((run) => !run.preparedByViewer).map((run) => run.runId)) : new Set())}/><span className="text-xs">{selected.size} selected</span><Input value={sharedReason} onChange={(event) => setSharedReason(event.target.value)} placeholder="What did you verify for these runs?" className="h-8 min-w-64 flex-1 text-xs"/><Button size="sm" variant="outline" disabled={pending || selected.size === 0} onClick={() => void decideSelected("allow")}>Release selected</Button><Button size="sm" variant="ghost" disabled={pending || selected.size === 0} onClick={() => void decideSelected("block")}>Keep selected blocked</Button></div>
          {blockedRuns.map((blocked) => (
            <div key={blocked.reviewId} className="px-4 py-3 sm:px-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex items-center gap-2 text-xs">
                  {!blocked.preparedByViewer ? <Checkbox checked={selected.has(blocked.runId)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(blocked.runId); else next.delete(blocked.runId); return next })}/> : null}
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
