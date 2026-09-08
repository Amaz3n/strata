"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { FileText, MoreHorizontal, Plus, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Invoice, InvoiceLienWaiver, Payment, PaymentReversal } from "@/lib/types"
import { INVOICE_WAIVER_TYPE_LABELS } from "@/lib/types"
import { availableWaiverPayments, readWaiverWorkflow, waiverPaymentIds } from "@/lib/lien-waivers/invoice-waiver"
import { unwrapAction } from "@/lib/action-result"
import { voidInvoiceLienWaiverAction } from "@/app/(app)/invoices/actions"
import { shareWaiverAction, matchWaiverPaymentAction } from "@/app/(app)/invoices/waiver-actions"
import { formatDateOnly, formatMoneyFromCents } from "./invoice-presentation"
import { cn } from "@/lib/utils"

const loadPreparation = () => import("./waiver-preparation")
const WaiverPreparation = dynamic(loadPreparation, { ssr: false, loading: () => <Dialog open><DialogContent><DialogTitle>Prepare waiver</DialogTitle><DialogDescription>Opening your waiver workspace…</DialogDescription><Loader2 className="mx-auto my-8 size-5 animate-spin" /></DialogContent></Dialog> })

export function InvoiceWaiverCard({ invoice, waivers, payments = [], reversals = [], link, failed, onChanged }: {
  invoice: Invoice; waivers: InvoiceLienWaiver[]; payments?: Payment[]; reversals?: PaymentReversal[];
  link?: string; failed?: boolean; onChanged: () => void | Promise<void>;
}) {
  const [items, setItems] = useState(waivers)
  const [preparing, setPreparing] = useState(false)
  const [draft, setDraft] = useState<InvoiceLienWaiver>()
  const [busy, setBusy] = useState<string | null>(null)
  const [matching, setMatching] = useState<InvoiceLienWaiver | null>(null)
  const [paymentId, setPaymentId] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => { setItems(waivers) }, [waivers])
  const available = availableWaiverPayments(payments, reversals)
  function saved(waiver: InvoiceLienWaiver) {
    const replaces = readWaiverWorkflow(waiver)?.input.replaces_draft_id
    setItems((current) => [waiver, ...current.filter((w) => w.id !== waiver.id && !(w.id === replaces && readWaiverWorkflow(w)?.lifecycle === "draft"))])
  }
  async function mutate(id: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(id)
    try { await work(); void Promise.resolve(onChanged()).catch(() => toast.error("Saved. Refresh to see the latest billing details.")) }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not update waiver") }
    finally { setBusy(null) }
  }
  const open = (existing?: InvoiceLienWaiver) => { setDraft(existing); setPreparing(true) }
  return <section className="space-y-2">
    <div className="flex items-center justify-between"><h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Your company’s waivers</h3>
      {items.length > 0 && <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={invoice.status === "void" || failed} onMouseEnter={() => void loadPreparation()} onFocus={() => void loadPreparation()} onClick={() => open()}><Plus className="mr-1 size-3" />Prepare</Button>}
    </div>
    {failed ? <p className="rounded-lg border p-3 text-xs text-warning">Waivers could not be loaded. Refresh the invoice to try again.</p> : items.length === 0 ?
      <button type="button" onMouseEnter={() => void loadPreparation()} onFocus={() => void loadPreparation()} onClick={() => open()} disabled={invoice.status === "void"}
        className="group flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors duration-150 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><FileText className="size-4 text-muted-foreground" /></span>
        <span className="min-w-0 flex-1"><span className="block text-xs font-medium">Prepare a waiver</span><span className="mt-1 block text-[11px] text-muted-foreground">Prepare from a company template, then sign in Arc.</span></span><Plus className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:scale-110 motion-reduce:transform-none" />
      </button> : <div className="divide-y overflow-hidden rounded-xl border bg-card">{items.map((waiver) => {
        const workflow = readWaiverWorkflow(waiver)
        const isDraft = workflow?.lifecycle === "draft"
        const matchedIds = workflow ? waiverPaymentIds(workflow) : []
        const matchedPayments = available.filter((p) => matchedIds.includes(p.id))
        const paymentChanged = matchedIds.length > 0 && (matchedPayments.length !== matchedIds.length || matchedPayments.reduce((sum, p) => sum + p.available_cents, 0) < waiver.amount_cents)
        const href = workflow ? `/api/invoices/${invoice.id}/waivers/${waiver.id}` : link ? `${link}/waiver/${waiver.id}` : undefined
        return <div key={waiver.id} className="flex items-start gap-3 p-3.5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1.5"><div className="flex items-baseline justify-between gap-2"><p className="text-xs font-medium">{INVOICE_WAIVER_TYPE_LABELS[waiver.waiver_type]}</p><span className="shrink-0 text-xs font-medium tabular-nums">{formatMoneyFromCents(waiver.amount_cents)}</span></div>
            <p className="text-[11px] text-muted-foreground">{workflow?.template_name ? workflow.template_name : workflow?.source === "upload" ? "Signed elsewhere" : "Arc form"}{waiver.through_date ? ` · Through ${formatDateOnly(waiver.through_date)}` : ""}</p>
            <p className={cn("text-[11px]", paymentChanged ? "text-warning" : "text-muted-foreground")}>{workflow?.needs_review ? "Details changed during signing · Prepare a new waiver" : isDraft ? workflow?.signing_document_id ? "In signing · Only your team can see this" : "Draft · Only your team can see this" : paymentChanged ? "Payment changed · Review payment evidence" : workflow ? `${workflow.shared ? "Included with invoice" : "Internal only"} · ${workflow.payment_id ? "Payment matched" : "Awaiting payment match"}` : waiver.status === "released" ? "Payment recorded" : "Awaiting payment"}</p>
            {isDraft ? <button type="button" onClick={() => open(waiver)} className="text-[11px] font-medium underline-offset-4 hover:underline">{workflow?.signing_document_id ? "Continue signing" : "Review & finish"}</button> : href ? <a href={href} target="_blank" rel="noreferrer" className="text-[11px] font-medium underline-offset-4 hover:underline">View document</a> : null}
          </div>
          <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="Waiver actions" size="icon" variant="ghost" className="-mr-1 -mt-1 size-7 shrink-0" disabled={Boolean(busy) || invoice.status === "void"}>{busy === waiver.id ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}</Button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {workflow && !isDraft && <><DropdownMenuItem onSelect={() => void mutate(waiver.id, async () => { saved(unwrapAction(await shareWaiverAction(invoice.id, waiver.id, !workflow.shared))); toast.success(workflow.shared ? "Removed from client invoice" : "Included with client invoice") })}>{workflow.shared ? "Keep internal only" : "Include with invoice"}</DropdownMenuItem><DropdownMenuItem onSelect={() => { setMatching(waiver); setPaymentId(""); setConfirmed(false) }}>Match payment…</DropdownMenuItem></>}
            {((isDraft && !workflow?.signing_document_id) || !workflow && waiver.status === "pending_payment") && <DropdownMenuItem onSelect={() => void mutate(waiver.id, async () => { unwrapAction(await voidInvoiceLienWaiverAction(waiver.id)); setItems((rows) => rows.filter((w) => w.id !== waiver.id)); toast.success("Draft removed") })}>Discard draft</DropdownMenuItem>}
            {workflow && !isDraft && <DropdownMenuItem disabled>Signed copy retained in history</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>
        </div>
      })}</div>}
    {preparing && <WaiverPreparation invoice={invoice} draft={draft} onSaved={saved} onClose={() => { setPreparing(false); void Promise.resolve(onChanged()).catch(() => {}) }} />}
    <Dialog open={Boolean(matching)} onOpenChange={(open) => { if (!open && !busy) setMatching(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Match received payment</DialogTitle><DialogDescription>Connect the funds covered by this waiver. Its signed document stays unchanged.</DialogDescription></DialogHeader>
      <Select value={paymentId} onValueChange={setPaymentId}><SelectTrigger aria-label="Received payment"><SelectValue placeholder="Choose payment" /></SelectTrigger><SelectContent>{available.length > 1 && available.reduce((sum, p) => sum + p.available_cents, 0) >= (matching?.amount_cents ?? 0) && <SelectItem value="all">All received payments · {formatMoneyFromCents(available.reduce((sum, p) => sum + p.available_cents, 0))}</SelectItem>}{available.filter((p) => p.available_cents >= (matching?.amount_cents ?? 0)).map((p) => <SelectItem key={p.id} value={p.id}>{formatMoneyFromCents(p.available_cents)} · {formatDateOnly(p.received_at)}</SelectItem>)}</SelectContent></Select>
      {available.reduce((sum, p) => sum + p.available_cents, 0) < (matching?.amount_cents ?? 0) && <p className="text-xs text-muted-foreground">Record a payment covering this waiver on the invoice first.</p>}
      <label className="flex items-start gap-3 py-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />I confirm the covered funds were received.</label>
      <DialogFooter><Button disabled={!matching || !paymentId || !confirmed || Boolean(busy)} onClick={() => matching && void mutate(matching.id, async () => { saved(unwrapAction(await matchWaiverPaymentAction(invoice.id, matching.id, paymentId === "all" ? available.map((p) => p.id) : paymentId, confirmed))); setMatching(null); toast.success("Payment matched") })}>{busy ? "Saving…" : "Match payment"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
