"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Camera, CheckCircle2 } from "lucide-react"

import { reportPurchaseOrderCompleteAction } from "./actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

type PurchaseOrder = {
  id: string; title: string; status: string; total_cents: number; contract_number: string | null; scope: string | null
  lines: Array<{ id: string; description: string; quantity: number; unit: string | null; scheduled_value_cents: number }>
  changes: Array<{ id: string; title: string; status: string; total_cents: number; reason: { label: string } | Array<{ label: string }> | null }>
  completions: Array<{ id: string; status: string; reported_at: string; amount_cents: number | null; vendor_bill: { status: string; paid_cents: number; total_cents: number } | null }>
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

export function PurchaseOrdersClient({ token, orders, canReport }: { token: string; orders: PurchaseOrder[]; canReport: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  return <div className="space-y-3">{orders.map((order) => {
    const approvedVariance = order.changes.filter((change) => change.status === "approved").reduce((sum, change) => sum + change.total_cents, 0)
    const latest = order.completions[0]
    return <section key={order.id} className="border bg-card p-4">
      <div className="flex items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{order.title}</h2><Badge variant="outline" className="rounded-none capitalize">{latest?.status ?? order.status}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{order.contract_number || "Purchase order"} · Revised {money(order.total_cents + approvedVariance)}</p></div>{canReport && !latest && <Button size="sm" onClick={() => setOpenId(openId === order.id ? null : order.id)}><CheckCircle2 /> Mark complete</Button>}</div>
      {order.scope && <p className="mt-3 whitespace-pre-wrap border-l-2 pl-3 text-sm text-muted-foreground">{order.scope}</p>}
      <div className="mt-4 divide-y border-y">{order.lines.map((line) => <div key={line.id} className="flex justify-between gap-4 py-2 text-sm"><span>{line.description} <span className="text-muted-foreground">({line.quantity} {line.unit || "ea"})</span></span><span className="tabular-nums">{money(line.scheduled_value_cents)}</span></div>)}</div>
      {order.changes.length > 0 && <div className="mt-3 text-xs text-muted-foreground">Approved VPOs: {money(approvedVariance)} · {order.changes.length} total</div>}
      {latest && <div className="mt-3 border bg-muted/20 p-3 text-sm"><div className="font-medium capitalize">Completion {latest.status}</div><div className="text-xs text-muted-foreground">Reported {new Date(latest.reported_at).toLocaleDateString()}{latest.vendor_bill ? ` · Bill ${latest.vendor_bill.status} · Paid ${money(latest.vendor_bill.paid_cents)}` : ""}</div></div>}
      {openId === order.id && <form className="mt-4 space-y-3 border-t pt-4" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { const result = await reportPurchaseOrderCompleteAction(token, form); if (result.success) { toast.success("Completion reported"); setOpenId(null) } else toast.error(result.error) }) }}>
        <input type="hidden" name="commitment_id" value={order.id} />
        <fieldset><legend className="mb-2 text-sm font-medium">Completed lines</legend>{order.lines.map((line) => <label key={line.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" name="commitment_line_id" value={line.id} defaultChecked /> {line.description}</label>)}</fieldset>
        <label className="grid gap-1 text-sm"><span className="font-medium">Completion photos</span><span className="text-xs text-muted-foreground">At least one photo is required.</span><input className="block w-full border p-2 text-sm" type="file" name="photos" accept="image/*" capture="environment" multiple required /></label>
        <label className="grid gap-1 text-sm"><span className="font-medium">Note</span><Textarea name="notes" rows={3} /></label>
        <Button disabled={pending}><Camera /> Submit completion</Button>
      </form>}
    </section>
  })}{orders.length === 0 && <div className="border p-8 text-center text-sm text-muted-foreground">No purchase orders are available for this project.</div>}</div>
}
