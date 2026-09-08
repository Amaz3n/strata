"use client"

import { Fragment, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  downloadSettlementStatementAction,
  markClearedToCloseAction,
  removeClosingAdjustmentAction,
  scheduleClosingAction,
  settleClosingAction,
  updateClosingChecklistItemAction,
  upsertClosingAdjustmentAction,
} from "@/app/(app)/projects/[id]/closing/actions"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import {
  buildSettlementStatementLines,
  type SettlementStatementLines,
} from "@/lib/financials/purchase-agreement-pricing"
import type { getClosing } from "@/lib/services/closings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type ClosingDetail = NonNullable<Awaited<ReturnType<typeof getClosing>>>
type SettlementPreview = ClosingDetail["settlementPreview"]

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** Statement convention: a credit prints in parentheses, not with a leading minus. */
function statementAmount(cents: number) {
  const formatted = money.format(Math.abs(cents) / 100)
  return cents < 0 ? `(${formatted})` : formatted
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function ClosingWorkbench({ projectId, detail }: { projectId: string; detail: ClosingDetail }) {
  const [pending, startTransition] = useTransition()
  const [scheduledDate, setScheduledDate] = useState(detail.closing.scheduled_date ?? "")
  const [paymentReference, setPaymentReference] = useState("")
  // Settlement is recorded after the fact as often as not — a Friday closing
  // gets entered Monday — so the date is an input, not the clock.
  const [actualDate, setActualDate] = useState(today())
  const [paymentMethod, setPaymentMethod] = useState<"wire" | "check">("wire")
  const act = <T,>(operation: () => Promise<ActionResult<T>>, message: string) =>
    startTransition(async () => {
      try {
        unwrapAction(await operation())
        toast.success(message)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Action failed")
      }
    })
  const settlement = detail.settlementPreview
  const posting = (detail.closing.metadata ?? {}) as Record<string, unknown>

  return (
    <div className="space-y-5 p-4">
      {posting.books_posting_status ? <div className="border p-4 text-sm"><p>Books posting: {String(posting.books_posting_status).replaceAll("_", " ")}</p>{posting.books_posting_error ? <p className="mt-2 text-destructive">{String(posting.books_posting_error)}. Resolve the accounting issue, then retry settlement using the same date and payment reference.</p> : null}</div> : null}
      <SettlementStatement projectId={projectId} closing={detail.closing} settlement={settlement} />

      <section className="border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Closing pipeline</h2>
              <Badge variant="outline">{String(detail.closing.status).replaceAll("_", " ")}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {detail.closing.community?.name} · Lot {detail.closing.lot?.lot_number}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input className="w-40" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !scheduledDate || !["projected", "scheduled"].includes(detail.closing.status)}
              onClick={() => act(() => scheduleClosingAction(projectId, { closingId: detail.closing.id, scheduledDate }), "Closing scheduled")}
            >
              Schedule
            </Button>
            <Button
              size="sm"
              disabled={pending || detail.closing.status !== "scheduled"}
              onClick={() => act(() => markClearedToCloseAction(projectId, detail.closing.id), "Cleared to close")}
            >
              Clear to close
            </Button>
          </div>
        </div>
        <div className="divide-y">
          {detail.checklist.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {item.is_gate ? "Required gate" : "Checklist item"}
                  {item.notes ? ` · ${item.notes}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge variant={item.status === "complete" ? "secondary" : "outline"}>{item.status}</Badge>
                {item.status !== "complete" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || detail.closing.status === "closed"}
                    onClick={() => act(() => updateClosingChecklistItemAction(projectId, { itemId: item.id, status: "complete" }), "Checklist updated")}
                  >
                    Complete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <SettlementAdjustments projectId={projectId} closing={detail.closing} settlement={settlement} pending={pending} act={act} />

      {detail.closing.status === "cleared_to_close" && (
        <section className="border border-primary/30 bg-primary/5 p-4">
          <h2 className="text-sm font-semibold">Settle closing</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Bills the full purchase price on one closing invoice, applies every receipted deposit against it, records the{" "}
            {paymentMethod === "wire" ? "wire" : "check"} for the {money.format(settlement.balanceDueCents / 100)} balance, and closes the lot.
          </p>
          <div className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-[10rem_8rem_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="settlement-date" className="text-xs">Settlement date</Label>
              <Input id="settlement-date" type="date" max={today()} value={actualDate} onChange={(event) => setActualDate(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="settlement-method" className="text-xs">Method</Label>
              <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value === "check" ? "check" : "wire")}>
                <SelectTrigger id="settlement-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="wire">Wire</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="settlement-reference" className="text-xs">Reference</Label>
              <Input id="settlement-reference" placeholder="Wire or check reference" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} />
            </div>
            <Button
              disabled={pending || !paymentReference.trim() || !actualDate}
              onClick={() => act(() => settleClosingAction(projectId, { closingId: detail.closing.id, actualDate, paymentMethod, paymentReference }), "Closing settled")}
            >
              Settle closing
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * The settlement table the buyer signs, on screen. It is the same composition
 * the closing invoice bills and the PDF prints — one helper builds all three so
 * the number quoted here cannot drift from the number collected.
 */
function SettlementStatement({
  projectId,
  closing,
  settlement,
}: {
  projectId: string
  closing: ClosingDetail["closing"]
  settlement: SettlementPreview
}) {
  const [downloading, startDownload] = useTransition()
  const lines = useMemo<SettlementStatementLines | null>(() => {
    if (!settlement.pricing) return null
    return buildSettlementStatementLines({
      pricing: settlement.pricing,
      lotLabel: closing.lot?.lot_number ?? "—",
      planLabel: closing.lot?.plan?.name ?? "Home",
      approvedChangeOrders: (settlement.changeOrders ?? []).map((row) => ({
        id: String(row.id),
        title: row.title ?? "Change order",
        totalCents: Number(row.total_cents ?? 0),
        number: typeof row.metadata?.number === "number" ? row.metadata.number : null,
      })),
      adjustments: settlement.adjustments,
      deposits: settlement.depositsApplied,
    })
  }, [closing.lot, settlement])

  function download() {
    startDownload(async () => {
      try {
        const { fileName, pdfBase64 } = unwrapAction(await downloadSettlementStatementAction(projectId))
        const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = fileName
        anchor.click()
        URL.revokeObjectURL(url)
      } catch (error) {
        toast.error("Unable to generate the settlement statement", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  const settled = closing.status === "closed"

  return (
    <section className="border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-semibold">Settlement statement</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {settled
              ? "Final settlement as recorded at closing."
              : "Preview. Figures move with approved change orders and adjustments until the closing settles."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={download} disabled={downloading || !lines}>
          {downloading ? "Preparing…" : "Download settlement statement"}
        </Button>
      </div>

      {!lines ? (
        <p className="p-4 text-sm text-muted-foreground">
          This home has no purchase-agreement pricing snapshot yet, so the settlement cannot be itemized. Re-sync the agreement pricing to see the breakdown.
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Description</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {[
                { key: "purchase", label: "Purchase price", rows: lines.purchasePrice },
                { key: "changes", label: "Change orders", rows: lines.changeOrders },
                { key: "adjustments", label: "Settlement adjustments", rows: lines.adjustments },
              ]
                .filter((group) => group.rows.length > 0)
                .map((group) => (
                  <Fragment key={group.key}>
                    <tr className="border-b bg-muted/40">
                      <th colSpan={2} className="px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </th>
                    </tr>
                    {group.rows.map((row, index) => (
                      <tr key={`${group.key}-${index}`} className="border-b">
                        <td className="px-4 py-2">{row.description}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${row.amountCents < 0 ? "text-success" : ""}`}>
                          {statementAmount(row.amountCents)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              <tr className="border-b">
                <td className="px-4 py-2.5 font-semibold">Final price</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{statementAmount(lines.finalPriceCents)}</td>
              </tr>
              <tr className="border-b bg-muted/40">
                <th colSpan={2} className="px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Deposits credited
                </th>
              </tr>
              {lines.deposits.length === 0 ? (
                <tr className="border-b">
                  <td colSpan={2} className="px-4 py-2 text-muted-foreground">No deposits have been receipted against this home.</td>
                </tr>
              ) : (
                lines.deposits.map((deposit, index) => (
                  <tr key={`deposit-${index}`} className="border-b">
                    <td className="px-4 py-2">
                      {deposit.label}
                      <span className="ml-2 text-xs text-muted-foreground">{formatDate(deposit.receivedAt)}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{statementAmount(deposit.amountCents)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-4 border-t px-4 py-3">
            <span className="text-sm font-semibold">Balance due at closing</span>
            <span className="text-2xl font-semibold tabular-nums">{statementAmount(lines.balanceDueCents)}</span>
          </div>
        </>
      )}
    </section>
  )
}

const ADJUSTMENT_KINDS = [
  { value: "seller_credit", label: "Seller credit" },
  { value: "closing_cost", label: "Closing cost" },
  { value: "proration", label: "Proration" },
  { value: "other", label: "Other" },
] as const

/**
 * What the settlement table adds beyond the agreement. Amounts are entered from
 * the buyer's side: a credit to the buyer is negative and lowers what they owe.
 */
function SettlementAdjustments({
  projectId,
  closing,
  settlement,
  pending,
  act,
}: {
  projectId: string
  closing: ClosingDetail["closing"]
  settlement: SettlementPreview
  pending: boolean
  act: <T,>(operation: () => Promise<ActionResult<T>>, message: string) => void
}) {
  const [label, setLabel] = useState("")
  const [kind, setKind] = useState<string>("seller_credit")
  const [amount, setAmount] = useState("")
  const adjustments = settlement.adjustments ?? []
  const settled = closing.status === "closed"
  const parsedAmount = Number(amount)
  const amountValid = amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount !== 0
  const submit = () => {
    act(async () => {
      const result = await upsertClosingAdjustmentAction(projectId, { closingId: closing.id, label: label.trim(), kind, amountCents: Math.round(parsedAmount * 100) })
      setLabel("")
      setAmount("")
      return result
    }, "Settlement adjustment saved")
  }
  return (
    <section className="border bg-background">
      <div className="border-b p-4">
        <h2 className="font-semibold">Settlement adjustments</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Seller credits, closing costs the builder pays, and tax or HOA prorations. Enter a credit to the buyer as a negative amount.
        </p>
      </div>
      {adjustments.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No adjustments. The settlement is the agreement plus approved change orders.</p>
      ) : (
        <div className="divide-y">
          {adjustments.map((adjustment) => (
            <div key={adjustment.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{adjustment.label}</p>
                <p className="text-xs text-muted-foreground">
                  {ADJUSTMENT_KINDS.find((option) => option.value === adjustment.kind)?.label ?? adjustment.kind}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-sm font-semibold tabular-nums ${adjustment.amountCents < 0 ? "text-success" : ""}`}>
                  {money.format(adjustment.amountCents / 100)}
                </span>
                {!settled && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => removeClosingAdjustmentAction(projectId, closing.id, adjustment.id), "Adjustment removed")}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {!settled && (
        <div className="grid gap-3 border-t p-4 sm:grid-cols-[1fr_10rem_9rem_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="adjustment-label" className="text-xs">Description</Label>
            <Input id="adjustment-label" placeholder="Lender closing-cost assistance" value={label} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjustment-kind" className="text-xs">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="adjustment-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_KINDS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjustment-amount" className="text-xs">Amount</Label>
            <Input id="adjustment-amount" type="number" step="0.01" placeholder="-5000.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </div>
          <Button variant="outline" disabled={pending || !label.trim() || !amountValid} onClick={submit}>Add</Button>
        </div>
      )}
    </section>
  )
}
