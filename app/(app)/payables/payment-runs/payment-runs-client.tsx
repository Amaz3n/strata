"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import {
  ApprovePaymentRunDialog,
  SubmitPaymentRunDialog,
} from "@/components/payables/payment-run-dialogs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { estimateSettlement } from "@/lib/payments/settlement-estimate"
import type { PaymentReconciliationException, PaymentReconciliationSummary } from "@/lib/services/payment-reconciliation"
import type { PaymentRunSetupData } from "@/lib/services/payment-runs"
import type { BlockedPaymentRun } from "@/lib/services/payment-risk"
import {
  cancelPaymentRunAction,
  createPaymentRunAction,
  decidePaymentRiskReviewAction,
  decidePaymentRunAction,
  executePaymentRunAction,
  reconcilePaymentsAction,
  resolvePaymentExceptionAction,
  submitPaymentRunAction,
} from "./actions"

import type { PaymentRunListRow } from "@/lib/services/payment-runs"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function PaymentRunsClient({
  setup,
  runs,
  reconciliations,
  exceptions,
  blockedRuns,
  canReviewRisk,
  canReconcile,
  error,
  preselectedBillIds = [],
}: {
  setup: PaymentRunSetupData
  runs: PaymentRunListRow[]
  reconciliations: PaymentReconciliationSummary[]
  exceptions: PaymentReconciliationException[]
  blockedRuns: BlockedPaymentRun[]
  canReviewRisk: boolean
  canReconcile: boolean
  error?: string | null
  /** Bill ids handed over from the payables desk's Pay action. */
  preselectedBillIds?: string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const eligibleIds = useMemo(() => new Set(setup.eligibleBills.map((bill) => bill.id)), [setup.eligibleBills])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectedBillIds.filter((id) => eligibleIds.has(id))),
  )
  const droppedPreselected = preselectedBillIds.filter((id) => !eligibleIds.has(id)).length
  const [fundingSourceId, setFundingSourceId] = useState(setup.fundingSources.find((source) => source.isDefault)?.id ?? setup.fundingSources[0]?.id ?? "")
  const [message, setMessage] = useState<string | null>(
    error ??
      (droppedPreselected > 0
        ? `${droppedPreselected} selected ${droppedPreselected === 1 ? "bill is" : "bills are"} not payment-ready and ${droppedPreselected === 1 ? "was" : "were"} left out of the selection.`
        : null),
  )
  const selectedBills = useMemo(() => setup.eligibleBills.filter((bill) => selected.has(bill.id)), [selected, setup.eligibleBills])
  // Per-bill amount, defaulting to the full balance. Partial payment against a
  // pay application is routine, and the batch builder previously forced the
  // whole balance while the single-bill flow allowed a partial.
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const amountCentsFor = (bill: PaymentRunSetupData["eligibleBills"][number]) => {
    const raw = amounts[bill.id]
    if (raw == null || raw.trim() === "") return bill.outstandingCents
    const parsedAmount = Math.round(Number(raw) * 100)
    return Number.isFinite(parsedAmount) ? parsedAmount : bill.outstandingCents
  }
  const amountInvalid = (bill: PaymentRunSetupData["eligibleBills"][number]) => {
    const cents = amountCentsFor(bill)
    return cents <= 0 || cents > bill.outstandingCents
  }
  const selectedInvalid = selectedBills.some(amountInvalid)
  const selectedTotal = selectedBills.reduce((sum, bill) => sum + amountCentsFor(bill), 0)
  const [submittingRun, setSubmittingRun] = useState<PaymentRunListRow | null>(null)
  const [decidingRun, setDecidingRun] = useState<PaymentRunListRow | null>(null)
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({})
  const [riskReasons, setRiskReasons] = useState<Record<string, string>>({})
  const [runStatusFilter, setRunStatusFilter] = useState("all")
  const filteredRuns = useMemo(() => runStatusFilter === "all" ? runs : runs.filter((run) => run.status === runStatusFilter), [runStatusFilter, runs])
  const cashRequirements = useMemo(() => {
    const now = new Date()
    const totalThrough = (days: number) => runs.filter((run) => ["draft", "pending_approval", "approved", "processing"].includes(run.status)).filter((run) => {
      if (!run.scheduled_for) return true
      return new Date(`${run.scheduled_for}T23:59:59Z`).getTime() <= now.getTime() + days * 86_400_000
    }).reduce((sum, run) => sum + run.total_debit_cents, 0)
    return { seven: totalThrough(7), fourteen: totalThrough(14), thirty: totalThrough(30) }
  }, [runs])
  const dueDateByBillNumber = useMemo(
    () => new Map(setup.eligibleBills.map((bill) => [bill.billNumber, bill.dueDate])),
    [setup.eligibleBills],
  )
  const approverSummary = setup.routing.approvers.length > 0
    ? `Routes to ${setup.routing.approvers.length} designated ${setup.routing.approvers.length === 1 ? "approver" : "approvers"}. You cannot approve a run you prepared.`
    : "Anyone with payment approval permission can approve it. You cannot approve a run you prepared."

  const perform = (operation: () => Promise<{ success: boolean; error?: string }>, successMessage: string) => {
    setMessage(null)
    startTransition(async () => {
      const result = await operation()
      if (!result.success) {
        setMessage(result.error ?? "Payment operation failed")
        return
      }
      setMessage(successMessage)
      setSelected(new Set())
      router.refresh()
    })
  }

  const createRun = () => {
    if (!fundingSourceId || selectedBills.length === 0) return
    perform(() => createPaymentRunAction({
      funding_source_id: fundingSourceId,
      idempotency_key: crypto.randomUUID(),
      items: selectedBills.map((bill) => ({
        bill_id: bill.id,
        amount_cents: amountCentsFor(bill),
        retainage_held_cents: 0,
        payees: [{
          payee_kind: "primary_vendor",
          method: "ach",
          payee_name: bill.vendorName,
          amount_cents: amountCentsFor(bill),
        }],
      })),
    }), "Draft payment run created")
  }

  const reconcile = () => {
    const end = new Date()
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    perform(() => reconcilePaymentsAction({ period_start: start.toISOString(), period_end: end.toISOString() }), "Reconciliation complete")
  }

  const exportRun = (run: PaymentRunListRow) => {
    const rows = [["run_id", "status", "scheduled_for", "bill", "vendor", "project", "vendor_amount_cents", "processor_fee_cents", "platform_fee_cents", "total_debit_cents"], ...run.items.map((item) => [run.id, run.status, run.scheduled_for ?? "", item.billNumber, item.vendorName, item.projectName, String(item.vendorAmountCents), String(item.processorFeeCents), String(item.platformFeeCents), String(item.vendorAmountCents + item.processorFeeCents + item.platformFeeCents)])]
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `payment-run-${run.id}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="desk-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/payables" className="text-xs text-muted-foreground hover:text-foreground">Payables</Link>
          <h1 className="mt-1 text-xl font-semibold">Payment runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">Build, approve, release, and reconcile vendor ACH batches.</p>
        </div>
        {canReconcile ? <Button variant="outline" onClick={reconcile} disabled={pending}>Reconcile last 24 hours</Button> : null}
      </header>

      {message ? <div role="status" className="border bg-muted/40 px-4 py-3 text-sm">{message}</div> : null}

      <section className="desk-rise grid border bg-card sm:grid-cols-3">
        {[{ label: "Next 7 days", value: cashRequirements.seven }, { label: "Next 14 days", value: cashRequirements.fourteen }, { label: "Next 30 days", value: cashRequirements.thirty }].map((window, index) => <div key={window.label} className={`px-4 py-3 ${index > 0 ? "border-t sm:border-l sm:border-t-0" : ""}`}><p className="microlabel">Cash required · {window.label}</p><p className="mt-1 font-mono text-lg font-medium tabular-nums">{money(window.value)}</p></div>)}
      </section>

      <section className="desk-rise border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Eligible bills</h2>
            <p className="text-xs text-muted-foreground">Only approved bills with a verified vendor bank destination appear here. Showing up to 200. Each vendor debit is exactly what the vendor receives; Arc collects fees in one separate debit per run.</p>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="funding-source" className="text-xs">Funding source</Label>
              <Select value={fundingSourceId} onValueChange={setFundingSourceId}>
                <SelectTrigger id="funding-source" className="w-56"><SelectValue placeholder="No active bank" /></SelectTrigger>
                <SelectContent>{setup.fundingSources.map((source) => <SelectItem key={source.id} value={source.id}>{source.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button onClick={createRun} disabled={pending || selectedBills.length === 0 || !fundingSourceId || selectedInvalid}>
              Create run · {money(selectedTotal)}
            </Button>
          </div>
        </div>
        {setup.eligibleBills.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No payment-ready bills. Approve a bill and have the vendor finish bank onboarding.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="w-10 px-4 py-2">Select</th><th className="px-4 py-2">Bill</th><th className="px-4 py-2">Vendor</th><th className="px-4 py-2">Project</th><th className="px-4 py-2 text-right">Payable</th><th className="px-4 py-2 text-right">Pay now</th></tr></thead>
              <tbody>{setup.eligibleBills.map((bill) => <tr key={bill.id} className="border-b last:border-0"><td className="px-4 py-3"><Checkbox checked={selected.has(bill.id)} aria-label={`Select ${bill.billNumber}`} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(bill.id); else next.delete(bill.id); return next })} /></td><td className="px-4 py-3 font-medium">{bill.billNumber}{bill.discount ? <div className="text-xs font-normal text-success">Save {money(bill.discount.amountCents)} if received by {shortDate(`${bill.discount.byDate}T00:00:00Z`)}</div> : null}</td><td className="px-4 py-3">{bill.vendorName}</td><td className="px-4 py-3 text-muted-foreground">{bill.projectName}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(bill.outstandingCents)}</td><td className="px-4 py-3 text-right">{selected.has(bill.id) ? <Input inputMode="decimal" value={amounts[bill.id] ?? (bill.outstandingCents / 100).toFixed(2)} onChange={(event) => setAmounts((current) => ({ ...current, [bill.id]: event.target.value }))} aria-label={`Amount to pay for ${bill.billNumber}`} aria-invalid={amountInvalid(bill)} className={`ml-auto h-8 w-28 text-right font-mono tabular-nums ${amountInvalid(bill) ? "border-destructive" : ""}`} /> : <span className="text-muted-foreground">—</span>}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {canReviewRisk && blockedRuns.length > 0 ? (
        <section className="desk-rise border border-destructive/30 bg-card">
          <div className="border-b border-destructive/30 px-4 py-3">
            <h2 className="text-sm font-semibold">Blocked by risk controls</h2>
            <p className="text-xs text-muted-foreground">
              These runs will not release until a reviewer clears them. You cannot clear a block on a run you prepared.
            </p>
          </div>
          <div className="divide-y">
            {blockedRuns.map((blocked) => (
              <div key={blocked.reviewId} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <span className="font-mono text-sm font-medium tabular-nums">{money(blocked.totalDebitCents)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {blocked.paymentCount} {blocked.paymentCount === 1 ? "bill" : "bills"} · {blocked.runStatus.replaceAll("_", " ")} · {shortDate(blocked.createdAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {blocked.signals.filter((signal) => signal.severity === "block").map((signal) => (
                      <span key={signal.code} className="border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                        {signal.code.replaceAll("_", " ")}
                      </span>
                    ))}
                  </div>
                </div>
                {blocked.preparedByViewer ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    You prepared this run, so someone else has to decide it.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={riskReasons[blocked.runId] ?? ""}
                      onChange={(event) => setRiskReasons((current) => ({ ...current, [blocked.runId]: event.target.value }))}
                      placeholder="What did you verify? (required)"
                      aria-label={`Risk decision reason for run ${blocked.runId}`}
                      className="max-w-md"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || (riskReasons[blocked.runId]?.trim().length ?? 0) < 12}
                      onClick={() => perform(
                        () => decidePaymentRiskReviewAction({ run_id: blocked.runId, decision: "allow", reason: riskReasons[blocked.runId] ?? "" }),
                        "Risk block cleared",
                      )}
                    >
                      Release
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || (riskReasons[blocked.runId]?.trim().length ?? 0) < 12}
                      onClick={() => perform(
                        () => decidePaymentRiskReviewAction({ run_id: blocked.runId, decision: "block", reason: riskReasons[blocked.runId] ?? "" }),
                        "Risk block confirmed",
                      )}
                    >
                      Keep blocked
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="desk-rise border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">Recent runs</h2><p className="text-xs text-muted-foreground">Up to 100 most recent runs.</p></div><Select value={runStatusFilter} onValueChange={setRunStatusFilter}><SelectTrigger className="w-48" aria-label="Filter payment runs by status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{Array.from(new Set(runs.map((run) => run.status))).map((status) => <SelectItem key={status} value={status}>{status.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
        {filteredRuns.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No payment runs in this view.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-sm"><thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2">Created</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Release</th><th className="px-4 py-2 text-right">Bills</th><th className="px-4 py-2 text-right">Debit</th><th className="px-4 py-2 text-right">Provider cost<div className="font-normal normal-case">own debit</div></th><th className="px-4 py-2 text-right">Arc fee<div className="font-normal normal-case">own debit</div></th><th className="px-4 py-2 text-right">Action</th></tr></thead><tbody>{filteredRuns.map((run) => {
          const approvalCount = run.approvals.filter((approval) => approval.decision === "approved").length
          // A terminal run's release date is history; only a run still heading for
          // execution has a schedule worth projecting a vendor-receipt date from.
          const awaitingRelease = ["draft", "pending_approval", "approved"].includes(run.status)
          const settlement = awaitingRelease
            ? estimateSettlement({ initiatedOn: run.scheduled_for ?? todayIso(), window: setup.settlementWindow })
            : null
          return <tr key={run.id} className="border-b last:border-0"><td className="px-4 py-3 align-top">{shortDate(run.created_at)}</td><td className="px-4 py-3 align-top capitalize">{run.status.replaceAll("_", " ")}{run.status === "pending_approval" ? ` · ${approvalCount}/${run.required_approvals}` : ""}<div className="mt-2 space-y-1 text-xs normal-case text-muted-foreground">{run.items.map((item) => <div key={item.id}><span className="font-medium text-foreground">{item.billNumber}</span> · {item.vendorName} · {item.projectName} · {money(item.vendorAmountCents)} · {item.payees.map((payee) => payee.name).join(" + ")} · {item.releasableAtSubmission ? "release checks captured" : "review release evidence"}{item.waiverStatus ? ` · waiver ${item.waiverStatus}` : ""}</div>)}{run.details_truncated ? <div>Payment-run detail is limited to the 1,000 most recent bill rows.</div> : null}</div></td><td className="px-4 py-3 align-top text-xs">{run.scheduled_for ? <span className="tabular-nums">{shortDate(`${run.scheduled_for}T00:00:00Z`)}</span> : <span className="text-muted-foreground">{awaitingRelease ? "On approval" : "—"}</span>}{settlement ? <div className="mt-0.5 text-muted-foreground">Vendor ~{shortDate(`${settlement.vendorReceivesEarliest}T00:00:00Z`)}–{shortDate(`${settlement.vendorReceivesLatest}T00:00:00Z`)}</div> : null}</td><td className="px-4 py-3 text-right align-top tabular-nums">{run.payment_count}</td><td className="px-4 py-3 text-right align-top font-mono font-medium tabular-nums">{money(run.total_debit_cents)}</td><td className="px-4 py-3 text-right align-top font-mono tabular-nums text-muted-foreground">{money(run.processor_fee_cents)}</td><td className="px-4 py-3 text-right align-top font-mono tabular-nums text-muted-foreground">{money(run.platform_fee_cents)}</td><td className="px-4 py-3 text-right align-top"><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => exportRun(run)}>Export</Button>{run.status === "draft" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => setSubmittingRun(run)}>Submit</Button> : null}{run.status === "pending_approval" && run.content_hash && run.can_approve ? <Button size="sm" variant="outline" disabled={pending} onClick={() => setDecidingRun(run)}>Review</Button> : null}{run.status === "approved" ? <Button size="sm" disabled={pending} onClick={() => perform(() => executePaymentRunAction(run.id), "Payment execution started")}>Release</Button> : null}{run.can_cancel ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => perform(() => cancelPaymentRunAction(run.id), "Payment run canceled")}>Cancel</Button> : null}</div></td></tr>
        })}</tbody></table></div>}
      </section>

      {submittingRun ? (
        <SubmitPaymentRunDialog
          run={submittingRun}
          open
          onOpenChange={(next) => { if (!next) setSubmittingRun(null) }}
          settlementWindow={setup.settlementWindow}
          passThroughProcessorFees={setup.feePolicy.passThroughProcessorFees}
          approverSummary={approverSummary}
          billDueDates={submittingRun.items
            .map((item) => dueDateByBillNumber.get(item.billNumber) ?? null)
            .filter((due): due is string => Boolean(due))}
          pending={pending}
          onSubmit={(scheduledFor) => {
            const runId = submittingRun.id
            setSubmittingRun(null)
            perform(
              () => submitPaymentRunAction({ run_id: runId, scheduled_for: scheduledFor }),
              scheduledFor ? `Run submitted, scheduled for ${scheduledFor}` : "Run submitted for approval",
            )
          }}
        />
      ) : null}

      {decidingRun ? (
        <ApprovePaymentRunDialog
          run={decidingRun}
          open
          onOpenChange={(next) => { if (!next) setDecidingRun(null) }}
          settlementWindow={setup.settlementWindow}
          passThroughProcessorFees={setup.feePolicy.passThroughProcessorFees}
          pending={pending}
          onDecide={(decision, reason) => {
            const target = decidingRun
            setDecidingRun(null)
            perform(
              () => decidePaymentRunAction({
                run_id: target.id,
                decision,
                reason,
                content_hash: target.content_hash ?? "",
              }),
              decision === "approved" ? "Approval recorded" : "Run rejected",
            )
          }}
        />
      ) : null}

      {canReconcile ? <section className="desk-rise border bg-card">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Reconciliation</h2><p className="text-xs text-muted-foreground">Up to 100 recent provider checks.</p></div>
        {reconciliations.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No reconciliation runs yet.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2">Period</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Expected</th><th className="px-4 py-2 text-right">Provider</th><th className="px-4 py-2 text-right">Difference</th><th className="px-4 py-2 text-right">Exceptions</th></tr></thead><tbody>{reconciliations.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="px-4 py-3">{shortDate(row.periodStart)} – {shortDate(row.periodEnd)}</td><td className="px-4 py-3 capitalize">{row.status}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.expectedCents)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.providerCents)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.differenceCents)}</td><td className="px-4 py-3 text-right tabular-nums">{row.exceptionCount}</td></tr>)}</tbody></table></div>}
      </section> : null}

      {canReconcile && exceptions.length > 0 ? <section className="desk-rise border bg-card">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Open payment exceptions</h2><p className="text-xs text-muted-foreground">Resolve only after matching the provider record, bank activity, and Arc ledger.</p></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2">Created</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Provider reference</th><th className="px-4 py-2 text-right">Expected</th><th className="px-4 py-2 text-right">Provider</th><th className="px-4 py-2">Resolution evidence</th><th className="px-4 py-2 text-right">Action</th></tr></thead><tbody>{exceptions.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="px-4 py-3">{shortDate(item.createdAt)}</td><td className="px-4 py-3 capitalize">{item.status.replaceAll("_", " ")}</td><td className="px-4 py-3 font-mono text-xs">{item.providerReference ?? "Missing"}</td><td className="px-4 py-3 text-right font-mono">{money(item.expectedCents)}</td><td className="px-4 py-3 text-right font-mono">{money(item.providerCents)}</td><td className="px-4 py-3"><Input value={resolutionNotes[item.id] ?? ""} onChange={(event) => setResolutionNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="What was verified and corrected?" aria-label={`Resolution evidence for ${item.status}`} /></td><td className="px-4 py-3 text-right"><Button size="sm" variant="outline" disabled={pending || (resolutionNotes[item.id]?.trim().length ?? 0) < 8} onClick={() => perform(() => resolvePaymentExceptionAction({ itemId: item.id, note: resolutionNotes[item.id] ?? "" }), "Exception resolved")}>Resolve</Button></td></tr>)}</tbody></table></div>
      </section> : null}
    </div>
  )
}
