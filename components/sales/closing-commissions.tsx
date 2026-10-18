"use client"

import Link from "next/link"
import { useState, useTransition } from "react"

import { markPayrollCommissionPaidAction } from "@/app/(app)/sales/commission-actions"
import { AgreementCommissionPlan } from "@/components/sales/agreement-commission-plan"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import type { ClosingCommissionsView, CommissionObligationView, CommissionPayableState } from "@/lib/services/sales-commissions"
import { formatMoneyCentsExact } from "@/lib/utils"

const STATE: Record<CommissionPayableState, { label: string; tone: string }> = {
  pending_ap: { label: "Pending AP", tone: "border-warning/40 text-warning" },
  approved: { label: "Approved", tone: "border-primary/40 text-primary" },
  partial: { label: "Partly paid", tone: "border-primary/40 text-primary" },
  paid: { label: "Paid", tone: "border-success/40 text-success" },
  rejected: { label: "Rejected", tone: "border-destructive/40 text-destructive" },
  accrued: { label: "Accrued for payroll", tone: "border-warning/40 text-warning" },
  paid_payroll: { label: "Paid by payroll", tone: "border-success/40 text-success" },
  cleared: { label: "Cleared", tone: "text-muted-foreground" },
  reversed: { label: "Reversed", tone: "border-destructive/40 text-destructive" },
}

function terms(row: CommissionObligationView) {
  return row.flatCents !== null ? "Flat" : `${((row.rateBps ?? 0) / 100).toFixed(2)}%`
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function ClosingCommissionsSkeleton() {
  return (
    <section className="border bg-background" aria-busy="true" aria-label="Loading commissions">
      <div className="flex items-center justify-between border-b p-4"><Skeleton className="h-5 w-32" /><Skeleton className="h-5 w-24" /></div>
      <div className="space-y-2 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
    </section>
  )
}

export function ClosingCommissionsError({ message }: { message: string }) {
  return (
    <section role="alert" className="border border-destructive/40 bg-background p-4 text-sm">
      <p className="font-semibold">Commissions</p>
      <p className="mt-1 text-destructive">{message}</p>
    </section>
  )
}

function PayrollPaid({ projectId, row }: { projectId: string; row: CommissionObligationView }) {
  const [reference, setReference] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  return (
    <div className="flex items-center justify-end gap-2">
      <Input aria-label="Payroll run reference" className="h-8 w-36" placeholder="Payroll run" value={reference} onChange={(event) => setReference(event.target.value)} />
      <Button size="sm" variant="outline" disabled={pending || !reference.trim()}
        onClick={() => startTransition(async () => {
          try { unwrapAction(await markPayrollCommissionPaidAction(projectId, { obligationId: row.id, payrollReference: reference.trim(), paidOn: today() })); setError(null) }
          catch (failure) { setError(failure instanceof Error ? failure.message : "Not recorded") }
        })}>
        Mark paid
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </div>
  )
}

/**
 * The closing's commissions: the agreement's terms before settlement (with the
 * gate that holds the closing), then what settlement owes each payee and where
 * the payable stands -- in AP, in payroll, cleared, or clawed back.
 */
export function ClosingCommissions({ projectId, view, canMarkPayrollPaid = false }: {
  projectId: string
  view: ClosingCommissionsView | null
  canMarkPayrollPaid?: boolean
}) {
  if (!view) {
    return (
      <section className="border bg-background p-4 text-sm">
        <p className="font-semibold">Commissions</p>
        <p className="mt-1 text-muted-foreground">This home has no purchase agreement, so there are no commission terms yet.</p>
      </section>
    )
  }
  const settled = view.obligations.length > 0 || view.hiddenObligationCount > 0
  const owed = view.obligations.filter((row) => !row.adjustment && row.status === "open").reduce((sum, row) => sum + row.amountCents, 0)
  const clawback = view.obligations.reduce((sum, row) => sum + row.clawbackOpenCents, 0)
  return (
    <section className="border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-semibold">Commissions</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {settled ? "Cost of sale on the authorized price; not construction cost." : "Paid on the authorized price at closing: agreement plus signed change orders, before closing-table credits."}
          </p>
        </div>
        {view.closingRefusal ? <Badge variant="outline" className="border-warning/40 text-warning">Holds closing</Badge> : null}
        {settled && owed > 0 ? <p className="text-sm tabular-nums">Owed <span className="font-medium">{formatMoneyCentsExact(owed)}</span></p> : null}
      </div>
      {view.closingRefusal ? <p className="border-b px-4 py-2 text-sm text-warning">{view.closingRefusal}</p> : null}
      {settled ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Payee</th>
                <th className="px-4 py-2 text-right font-medium">Basis</th>
                <th className="px-4 py-2 text-right font-medium">Terms</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Payable</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {view.obligations.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2">
                    <p className="font-medium">{row.adjustment ? `Clawback · ${row.payeeName}` : row.payeeName}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.kind === "coop_broker" ? "Co-op broker" : "Sales consultant"} · {row.payoutChannel === "payroll" ? "payroll" : row.billNumber ?? "payables"}
                    </p>
                    {row.endReason ? <p className="text-xs text-muted-foreground">{row.endReason}</p> : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoneyCentsExact(row.basisPriceCents)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{terms(row)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${row.amountCents < 0 ? "text-destructive" : ""}`}>{formatMoneyCentsExact(row.amountCents)}</td>
                  <td className="px-4 py-2">
                    <Badge variant="outline" className={STATE[row.state].tone}>{row.adjustment ? (row.payrollReference ? "Deducted" : "Deduct in payroll") : STATE[row.state].label}</Badge>
                    {row.clawbackOpenCents > 0 ? <p className="mt-1 text-xs text-destructive tabular-nums">{formatMoneyCentsExact(row.clawbackOpenCents)} to recover</p> : null}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {row.billId ? <Link className="text-xs underline-offset-2 hover:underline" href={`/payables?bill=${row.creditBillId ?? row.billId}`}>{row.creditBillId ? "Open credit" : "Open payable"}</Link> : null}
                    {row.payoutChannel === "payroll" && row.status === "open" && !row.payrollReference && canMarkPayrollPaid ? <PayrollPaid projectId={projectId} row={row} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.hiddenObligationCount > 0 ? <p className="px-4 py-2 text-xs text-muted-foreground">{view.hiddenObligationCount} consultant {view.hiddenObligationCount === 1 ? "commission is" : "commissions are"} private to the payee and approvers.</p> : null}
          {clawback > 0 ? <p className="border-t px-4 py-2 text-sm text-destructive tabular-nums">{formatMoneyCentsExact(clawback)} paid before the reversal is open to recover; it nets the payee&apos;s next payment.</p> : null}
        </div>
      ) : (
        <div className="p-4">
          <AgreementCommissionPlan contractId={view.contractId} projectId={projectId} />
        </div>
      )}
    </section>
  )
}
