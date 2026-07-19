"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { markClearedToCloseAction, scheduleClosingAction, settleClosingAction, updateClosingChecklistItemAction } from "@/app/(app)/projects/[id]/closing/actions"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function ClosingWorkbench({ projectId, detail }: { projectId: string; detail: any }) {
  const [pending, startTransition] = useTransition()
  const [scheduledDate, setScheduledDate] = useState(detail.closing.scheduled_date ?? "")
  const [paymentReference, setPaymentReference] = useState("")
  const act = (operation: () => Promise<any>, message: string) => startTransition(async () => { try { unwrapAction(await operation()); toast.success(message) } catch (error) { toast.error(error instanceof Error ? error.message : "Action failed") } })
  const settlement = detail.settlementPreview
  return <div className="space-y-5 p-4">
    <div className="grid gap-3 sm:grid-cols-4"><Metric label="Agreement" value={money.format(settlement.components.agreementTotalCents / 100)} /><Metric label="Approved changes" value={money.format(settlement.components.approvedChangeOrdersCents / 100)} /><Metric label="Deposits received" value={money.format(settlement.depositsAppliedCents / 100)} /><Metric label="Balance at closing" value={money.format(settlement.balanceDueCents / 100)} /></div>
    <section className="rounded-lg border bg-background"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><div className="flex items-center gap-2"><h2 className="font-semibold">Closing pipeline</h2><Badge variant="outline">{String(detail.closing.status).replaceAll("_", " ")}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{detail.closing.community?.name} · Lot {detail.closing.lot?.lot_number}</p></div><div className="flex items-center gap-2"><Input className="w-40" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} /><Button size="sm" variant="outline" disabled={pending || !scheduledDate || !["projected", "scheduled"].includes(detail.closing.status)} onClick={() => act(() => scheduleClosingAction(projectId, { closingId: detail.closing.id, scheduledDate }), "Closing scheduled")}>Schedule</Button><Button size="sm" disabled={pending || detail.closing.status !== "scheduled"} onClick={() => act(() => markClearedToCloseAction(projectId, detail.closing.id), "Cleared to close")}>Clear to close</Button></div></div>
      <div className="divide-y">{detail.checklist.map((item: any) => <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-3"><div><p className="text-sm font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{item.is_gate ? "Required gate" : "Checklist item"}{item.notes ? ` · ${item.notes}` : ""}</p></div><div className="flex gap-2"><Badge variant={item.status === "complete" ? "secondary" : "outline"}>{item.status}</Badge>{item.status !== "complete" && <Button size="sm" variant="outline" disabled={pending || detail.closing.status === "closed"} onClick={() => act(() => updateClosingChecklistItemAction(projectId, { itemId: item.id, status: "complete" }), "Checklist updated")}>Complete</Button>}</div></div>)}</div>
    </section>
    {detail.closing.status === "cleared_to_close" && <section className="rounded-lg border border-primary/30 bg-primary/5 p-4"><h2 className="text-sm font-semibold">Settle closing</h2><p className="mt-1 text-xs text-muted-foreground">Creates the single closing invoice, applies every receipted deposit as a credit, records the wire or check, and closes the lot.</p><div className="mt-3 flex max-w-xl gap-2"><Input placeholder="Wire or check reference" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} /><Button disabled={pending || !paymentReference.trim()} onClick={() => act(() => settleClosingAction(projectId, { closingId: detail.closing.id, actualDate: new Date().toISOString().slice(0, 10), paymentMethod: "wire", paymentReference }), "Closing settled")}>Settle closing</Button></div></section>}
  </div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border bg-background px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div> }
