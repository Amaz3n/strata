"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { format } from "date-fns"
import { Check, Search } from "lucide-react"
import { toast } from "sonner"

import { recordMultiInvoicePaymentAction } from "@/app/(app)/payments/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { getReceivePaymentWorkspace } from "@/lib/services/payments"
import { formatMoneyCentsExact } from "@/lib/utils"

type Workspace = Awaited<ReturnType<typeof getReceivePaymentWorkspace>>

function parseDollars(value: string) {
  const amount = Number(value.replace(/[$,]/g, ""))
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

export function ReceivePaymentWorkspace({ workspace }: { workspace: Workspace }) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [method, setMethod] = useState<"ach" | "card" | "wire" | "check">("check")
  const [reference, setReference] = useState("")
  const [receivedOn, setReceivedOn] = useState(format(new Date(), "yyyy-MM-dd"))
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return workspace.invoices.filter((invoice) =>
      !query || `${invoice.invoiceNumber} ${invoice.customerName} ${invoice.projectName}`.toLowerCase().includes(query),
    )
  }, [search, workspace.invoices])
  const allocations = workspace.invoices
    .map((invoice) => ({ invoice_id: invoice.id, amount_cents: parseDollars(amounts[invoice.id] ?? "") }))
    .filter((allocation) => allocation.amount_cents > 0)
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount_cents, 0)

  const submit = () => {
    const invalid = allocations.find((allocation) => {
      const invoice = workspace.invoices.find((item) => item.id === allocation.invoice_id)
      return !invoice || allocation.amount_cents > invoice.balanceCents
    })
    if (!allocations.length) return toast.error("Apply the receipt to at least one invoice")
    if (invalid) return toast.error("An allocation exceeds the invoice’s open balance")
    const receivedAt = new Date(`${receivedOn}T12:00:00`)
    if (Number.isNaN(receivedAt.getTime())) return toast.error("Enter a valid receipt date")

    startTransition(async () => {
      const result = await recordMultiInvoicePaymentAction({
        received_at: receivedAt.toISOString(),
        method,
        reference: reference.trim() || undefined,
        idempotency_key: `manual-receipt:${crypto.randomUUID()}`,
        party_type: workspace.partyType ?? undefined,
        party_id: workspace.partyId ?? undefined,
        allocations,
        metadata: { source: "receive_payment_workspace" },
      })
      if (!result.success) { toast.error(result.error); return }
      toast.success(`Receipt recorded across ${allocations.length} invoice${allocations.length === 1 ? "" : "s"}`)
      setAmounts({})
      setReference("")
      router.refresh()
    })
  }

  return (
    <div className="min-h-full bg-muted/15">
      <section className="border-b bg-background">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-end lg:px-8">
          <div>
            <p className="microlabel">Customer receipt</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Apply one payment across open invoices</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">The receipt stays one auditable event while each invoice keeps its own projected payment fact.</p>
          </div>
          <div className="text-right"><p className="microlabel">Applied total</p><p className="mt-1 font-mono text-3xl font-medium tabular-nums">{formatMoneyCentsExact(total)}</p></div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[1.5fr_.65fr] lg:px-8">
        <section className="border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div><h2 className="text-sm font-semibold">Open invoices</h2><p className="text-xs text-muted-foreground">Enter only the amount from this receipt.</p></div>
            <div className="relative w-full sm:w-72"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="Invoice, customer, or project" /></div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2 font-medium">Invoice</th><th className="px-3 py-2 font-medium">Customer / project</th><th className="px-3 py-2 text-right font-medium">Open</th><th className="px-4 py-2 text-right font-medium">Apply</th></tr></thead>
              <tbody>
                {visible.map((invoice) => {
                  const applied = parseDollars(amounts[invoice.id] ?? "")
                  return (
                    <tr key={invoice.id} className="border-b last:border-0">
                      <td className="px-4 py-3"><Link className="font-medium underline-offset-4 hover:underline" href={`/invoices?invoice=${invoice.id}&project=${invoice.projectId}`}>{invoice.invoiceNumber}</Link><p className="mt-0.5 text-xs text-muted-foreground">{invoice.dueDate ? `Due ${invoice.dueDate}` : "No due date"}</p></td>
                      <td className="px-3 py-3"><p>{invoice.customerName}</p><p className="text-xs text-muted-foreground">{invoice.projectName}</p></td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMoneyCentsExact(invoice.balanceCents)}</td>
                      <td className="px-4 py-3"><div className="ml-auto flex w-44 items-center gap-2"><Input inputMode="decimal" value={amounts[invoice.id] ?? ""} onChange={(event) => setAmounts((current) => ({ ...current, [invoice.id]: event.target.value }))} placeholder="0.00" className="text-right font-mono" aria-label={`Amount applied to ${invoice.invoiceNumber}`} /><Button size="icon" variant={applied === invoice.balanceCents ? "default" : "outline"} title="Apply full balance" onClick={() => setAmounts((current) => ({ ...current, [invoice.id]: (invoice.balanceCents / 100).toFixed(2) }))}><Check className="h-4 w-4" /></Button></div></td>
                    </tr>
                  )
                })}
                {!visible.length ? <tr><td colSpan={4} className="px-5 py-12 text-center text-sm text-muted-foreground">No open invoices match this account or search.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <div className="space-y-5">
          <section className="space-y-4 border bg-background p-4">
            <div><h2 className="text-sm font-semibold">Receipt details</h2><p className="text-xs text-muted-foreground">These details are shared by every allocation.</p></div>
            <label className="block space-y-1.5 text-xs font-medium">Received on<Input type="date" max={format(new Date(), "yyyy-MM-dd")} value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} /></label>
            <label className="block space-y-1.5 text-xs font-medium">Method<Select value={method} onValueChange={(value) => setMethod(value as typeof method)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="check">Check</SelectItem><SelectItem value="ach">ACH</SelectItem><SelectItem value="wire">Wire</SelectItem><SelectItem value="card">Card</SelectItem></SelectContent></Select></label>
            <label className="block space-y-1.5 text-xs font-medium">Reference<Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Check number or bank reference" /></label>
            <div className="border-t pt-4"><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">{allocations.length} allocation{allocations.length === 1 ? "" : "s"}</span><span className="font-mono font-semibold tabular-nums">{formatMoneyCentsExact(total)}</span></div><Button className="mt-4 w-full" disabled={pending || total <= 0} onClick={submit}>{pending ? "Recording receipt…" : "Record receipt"}</Button></div>
          </section>
          <section className="border bg-background"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Recent grouped receipts</h2></div><div className="divide-y">{workspace.recentGroups.slice(0, 8).map((group) => <div key={group.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><div><p>{String(group.reference || group.method).toUpperCase()}</p><p className="text-xs text-muted-foreground">{String(group.received_at).slice(0, 10)}</p></div><span className="font-mono tabular-nums">{formatMoneyCentsExact(Number(group.total_cents))}</span></div>)}{!workspace.recentGroups.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">No grouped receipts yet.</p> : null}</div></section>
        </div>
      </div>
    </div>
  )
}
