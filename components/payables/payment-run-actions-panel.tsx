"use client"

import * as React from "react"
import { toast } from "sonner"

import { cancelPaymentRunAction, decidePaymentRunAction, retryPaymentRunReleaseAction, syncPaymentRunItemsAction } from "@/app/(app)/payables/payment-runs/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function PaymentRunActionsPanel({ run }: { run: { id: string; status: string; content_hash: string | null; can_approve: boolean; can_cancel: boolean; paymentCount: number } }) {
  const [pending, startTransition] = React.useTransition()
  const [reason, setReason] = React.useState("")
  const decide = (decision: "approved" | "rejected") => startTransition(async () => {
    if (!run.content_hash) { toast.error("This run has no frozen content hash"); return }
    if (decision === "rejected" && reason.trim().length < 8) { toast.error("Give a rejection reason of at least 8 characters"); return }
    const result = await decidePaymentRunAction({ run_id: run.id, decision, content_hash: run.content_hash, reason: reason || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(decision === "approved" ? "Approval recorded" : "Payment run rejected")
    window.location.reload()
  })
  const formAction = (kind: "cancel" | "retry") => startTransition(async () => {
    const form = new FormData(); form.set("run_id", run.id); if (kind === "cancel") form.set("reason", reason)
    const result = kind === "cancel" ? await cancelPaymentRunAction(form) : await retryPaymentRunReleaseAction(form)
    if (!result.success) { toast.error(result.error); return }
    toast.success(kind === "cancel" ? "Payment run canceled" : "Release queued")
    window.location.reload()
  })
  return <section className="border">
    <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Actions</h2><p className="mt-0.5 text-xs text-muted-foreground">Approval and cancellation require a recent step-up verification.</p></div>
    <div className="space-y-3 p-4">
      {(run.can_approve || run.can_cancel) ? <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={run.can_approve ? "Reason (required for reject)" : "Cancellation reason"} disabled={pending}/> : null}
      <div className="flex flex-wrap gap-2">
        {run.can_approve ? <><Button disabled={pending} onClick={() => decide("approved")}>Approve</Button><Button disabled={pending} variant="destructive" onClick={() => decide("rejected")}>Reject</Button></> : null}
        {run.can_cancel ? <Button disabled={pending || reason.trim().length < 8} variant="outline" onClick={() => formAction("cancel")}>Cancel run</Button> : null}
        {run.status === "approved" ? <Button disabled={pending} variant="outline" onClick={() => formAction("retry")}>Retry release</Button> : null}
        <Button disabled={pending || run.paymentCount === 0} variant="outline" onClick={() => startTransition(async () => { const result = await syncPaymentRunItemsAction(run.id); if (!result.success) { toast.error(result.error); return } toast.success(`${result.data.queued} payments queued${result.data.failed ? ` · ${result.data.failed} failed` : ""}`); window.location.reload() })}>Sync all</Button>
      </div>
    </div>
  </section>
}
