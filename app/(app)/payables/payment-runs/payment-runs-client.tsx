"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PaymentReconciliationSummary } from "@/lib/services/payment-reconciliation"
import type { PaymentRunSetupData } from "@/lib/services/payment-runs"
import {
  cancelPaymentRunAction,
  createPaymentRunAction,
  decidePaymentRunAction,
  executePaymentRunAction,
  reconcilePaymentsAction,
  submitPaymentRunAction,
} from "./actions"

import type { PaymentRunListRow } from "@/lib/services/payment-runs"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
}

export function PaymentRunsClient({
  setup,
  runs,
  reconciliations,
  canReconcile,
  error,
}: {
  setup: PaymentRunSetupData
  runs: PaymentRunListRow[]
  reconciliations: PaymentReconciliationSummary[]
  canReconcile: boolean
  error?: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fundingSourceId, setFundingSourceId] = useState(setup.fundingSources.find((source) => source.isDefault)?.id ?? setup.fundingSources[0]?.id ?? "")
  const [message, setMessage] = useState<string | null>(error ?? null)
  const selectedBills = useMemo(() => setup.eligibleBills.filter((bill) => selected.has(bill.id)), [selected, setup.eligibleBills])
  const selectedTotal = selectedBills.reduce((sum, bill) => sum + bill.outstandingCents, 0)

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
        amount_cents: bill.outstandingCents,
        retainage_held_cents: 0,
        payees: [{
          payee_kind: "primary_vendor",
          method: "ach",
          recipient_account_id: bill.recipientAccountId,
          payee_name: bill.vendorName,
          amount_cents: bill.outstandingCents,
        }],
      })),
    }), "Draft payment run created")
  }

  const reconcile = () => {
    const end = new Date()
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    perform(() => reconcilePaymentsAction({ period_start: start.toISOString(), period_end: end.toISOString() }), "Reconciliation complete")
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

      <section className="desk-rise border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Eligible bills</h2>
            <p className="text-xs text-muted-foreground">Only approved bills with a verified vendor bank destination appear here. Showing up to 200.</p>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="funding-source" className="text-xs">Funding source</Label>
              <Select value={fundingSourceId} onValueChange={setFundingSourceId}>
                <SelectTrigger id="funding-source" className="w-56"><SelectValue placeholder="No active bank" /></SelectTrigger>
                <SelectContent>{setup.fundingSources.map((source) => <SelectItem key={source.id} value={source.id}>{source.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button onClick={createRun} disabled={pending || selectedBills.length === 0 || !fundingSourceId}>
              Create run · {money(selectedTotal)}
            </Button>
          </div>
        </div>
        {setup.eligibleBills.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No payment-ready bills. Approve a bill and have the vendor finish bank onboarding.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="w-10 px-4 py-2">Select</th><th className="px-4 py-2">Bill</th><th className="px-4 py-2">Vendor</th><th className="px-4 py-2">Project</th><th className="px-4 py-2 text-right">Payable</th></tr></thead>
              <tbody>{setup.eligibleBills.map((bill) => <tr key={bill.id} className="border-b last:border-0"><td className="px-4 py-3"><Checkbox checked={selected.has(bill.id)} aria-label={`Select ${bill.billNumber}`} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(bill.id); else next.delete(bill.id); return next })} /></td><td className="px-4 py-3 font-medium">{bill.billNumber}</td><td className="px-4 py-3">{bill.vendorName}</td><td className="px-4 py-3 text-muted-foreground">{bill.projectName}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(bill.outstandingCents)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="desk-rise border bg-card">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Recent runs</h2><p className="text-xs text-muted-foreground">Up to 100 most recent runs.</p></div>
        {runs.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No payment runs yet.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2">Created</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Bills</th><th className="px-4 py-2 text-right">Vendor</th><th className="px-4 py-2 text-right">Fees</th><th className="px-4 py-2 text-right">Debit</th><th className="px-4 py-2 text-right">Action</th></tr></thead><tbody>{runs.map((run) => {
          const approvalCount = run.approvals.filter((approval) => approval.decision === "approved").length
          return <tr key={run.id} className="border-b last:border-0"><td className="px-4 py-3 align-top">{shortDate(run.created_at)}</td><td className="px-4 py-3 align-top capitalize">{run.status.replaceAll("_", " ")}{run.status === "pending_approval" ? ` · ${approvalCount}/${run.required_approvals}` : ""}<div className="mt-2 space-y-1 text-xs normal-case text-muted-foreground">{run.items.map((item) => <div key={item.id}><span className="font-medium text-foreground">{item.billNumber}</span> · {item.vendorName} · {item.projectName} · {money(item.vendorAmountCents)} · {item.payees.map((payee) => payee.name).join(" + ")} · {item.releasableAtSubmission ? "release checks captured" : "review release evidence"}{item.waiverStatus ? ` · waiver ${item.waiverStatus}` : ""}</div>)}{run.details_truncated ? <div>Payment-run detail is limited to the 1,000 most recent bill rows.</div> : null}</div></td><td className="px-4 py-3 text-right align-top tabular-nums">{run.payment_count}</td><td className="px-4 py-3 text-right align-top font-mono tabular-nums">{money(run.vendor_amount_cents)}</td><td className="px-4 py-3 text-right align-top font-mono tabular-nums">{money(run.processor_fee_cents + run.platform_fee_cents)}</td><td className="px-4 py-3 text-right align-top font-mono tabular-nums">{money(run.total_debit_cents)}</td><td className="px-4 py-3 text-right align-top"><div className="flex justify-end gap-2">{run.status === "draft" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => perform(() => submitPaymentRunAction(run.id), "Run submitted for approval")}>Submit</Button> : null}{run.status === "pending_approval" && run.content_hash && run.can_approve ? <><Button size="sm" variant="outline" disabled={pending} onClick={() => perform(() => decidePaymentRunAction({ run_id: run.id, decision: "approved", content_hash: run.content_hash ?? "" }), "Approval recorded")}>Approve</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => perform(() => decidePaymentRunAction({ run_id: run.id, decision: "rejected", reason: "Rejected by payment reviewer", content_hash: run.content_hash ?? "" }), "Run rejected")}>Reject</Button></> : null}{run.status === "approved" ? <Button size="sm" disabled={pending} onClick={() => perform(() => executePaymentRunAction(run.id), "Payment execution started")}>Release</Button> : null}{run.can_cancel ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => perform(() => cancelPaymentRunAction(run.id), "Payment run canceled")}>Cancel</Button> : null}</div></td></tr>
        })}</tbody></table></div>}
      </section>

      {canReconcile ? <section className="desk-rise border bg-card">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Reconciliation</h2><p className="text-xs text-muted-foreground">Up to 100 recent provider checks.</p></div>
        {reconciliations.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No reconciliation runs yet.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2">Period</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Expected</th><th className="px-4 py-2 text-right">Provider</th><th className="px-4 py-2 text-right">Difference</th><th className="px-4 py-2 text-right">Exceptions</th></tr></thead><tbody>{reconciliations.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="px-4 py-3">{shortDate(row.periodStart)} – {shortDate(row.periodEnd)}</td><td className="px-4 py-3 capitalize">{row.status}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.expectedCents)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.providerCents)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(row.differenceCents)}</td><td className="px-4 py-3 text-right tabular-nums">{row.exceptionCount}</td></tr>)}</tbody></table></div>}
      </section> : null}
    </div>
  )
}
