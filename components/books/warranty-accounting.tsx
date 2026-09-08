"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { approveWarrantyAccountingAction, reverseWarrantyAccountingAction, loadWarrantyAccountingAction, loadWarrantyCostSourcesAction, setWarrantyReserveEstimateAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { parseMoneyToCents } from "@/lib/financials/money-input"

type Visit = Awaited<ReturnType<typeof import("@/lib/services/books/warranty-accounting").getWarrantyAccountingWorkspace>>[number]
type CostSource = Awaited<ReturnType<typeof import("@/lib/services/books/warranty-accounting").getWarrantyCostSources>>[number]
const money = (cents: number) => (cents/100).toLocaleString("en-US", { style: "currency", currency: "USD" })
export function WarrantyAccounting() {
  const [visits,setVisits] = useState<Visit[] | null>(null)
  const [visit,setVisit] = useState<Visit | null>(null)
  const [sources,setSources] = useState<CostSource[]>([])
  const [amounts,setAmounts] = useState<Record<string,string>>({})
  const [pending,startTransition] = useTransition()
  const load = async () => { const result = await loadWarrantyAccountingAction(); if (!result.success) { toast.error(result.error); return } setVisits(result.data) }
  return <section id="warranty-accounting" className="space-y-3 border p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">Warranty cost accounting</h3><p className="text-sm text-muted-foreground">Visit submissions are estimates. Link posted expenses, bills, or labor to approve actual cost and consume the available reserve.</p></div><Button variant="outline" disabled={pending} onClick={() => startTransition(load)}>Review completed visits</Button></div>
    {visits?.length === 0 && <p className="text-sm text-muted-foreground">No completed visits to review.</p>}
    {visits?.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-3 text-sm"><div>{row.label}<p className="text-xs text-muted-foreground">Submitted {money(row.submittedCents)} · Approved {money(row.approvedCents)} · Reserve used {money(row.reserveCents)}</p></div><Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => {
      if (!row.approvedAt) { const result = await loadWarrantyCostSourcesAction(row.id); if (!result.success) { toast.error(result.error); return } setSources(result.data) }
      setVisit(row); setAmounts({})
    })}>{row.approvedAt ? "Reverse approval" : "Link actual costs"}</Button></div>)}
    <Dialog open={visit !== null} onOpenChange={open => { if (!open) setVisit(null) }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{visit?.approvedAt ? "Reverse cost approval" : "Approve actual warranty cost"}</DialogTitle><DialogDescription>{visit?.approvedAt ? "This reverses reserve consumption and releases the source allocations. The underlying expense remains recorded." : "Record the expense or bill first. Allocating a posted source does not create another expense."}</DialogDescription></DialogHeader>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!visit) return; const selected = visit; const data = new FormData(event.currentTarget); startTransition(async () => {
        try {
          const date = String(data.get("date") ?? "")
          const result = selected.approvedAt ? await reverseWarrantyAccountingAction({ visitId: selected.id, date, reason: String(data.get("reason") ?? "") }) : await approveWarrantyAccountingAction({ visitId: selected.id, date, evidenceUrl: String(data.get("evidenceUrl") ?? ""), sources: Object.entries(amounts).filter(([,value]) => value.trim() !== "").map(([jobCostEntryId,value]) => { const amountCents = parseMoneyToCents(value); if (amountCents === null) throw new Error("Enter valid source amounts"); return { jobCostEntryId, amountCents } }) })
          if (!result.success) { toast.error(result.error); return } toast.success("Warranty accounting updated"); setVisit(null); await load()
        } catch (error) { toast.error(error instanceof Error ? error.message : "Check source allocations") }
      }) }}>
        {!visit?.approvedAt && sources.map(source => <div key={source.id} className="grid grid-cols-[1fr_120px] items-center gap-2"><Label htmlFor={`warranty-cost-${source.id}`}>{source.label}<span className="block text-xs text-muted-foreground">{source.incurredOn} · {money(source.amountCents)}</span></Label><Input id={`warranty-cost-${source.id}`} value={amounts[source.id] ?? ""} inputMode="decimal" placeholder="Allocate" onChange={event => { const value=event.target.value; setAmounts(current => ({ ...current,[source.id]:value })) }} /></div>)}
        {!visit?.approvedAt && sources.length===0 && <p className="text-sm">Record and approve the source expense, bill, or time entry on the project first.</p>}
        <div className="space-y-1"><Label htmlFor="warranty-accounting-date">Accounting date</Label><Input id="warranty-accounting-date" type="date" name="date" required /></div>
        <div className="space-y-1"><Label htmlFor="warranty-accounting-evidence">{visit?.approvedAt ? "Reversal reason" : "Supporting evidence URL"}</Label><Input id="warranty-accounting-evidence" name={visit?.approvedAt ? "reason" : "evidenceUrl"} type={visit?.approvedAt ? "text" : "url"} required /></div>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : visit?.approvedAt ? "Reverse approval" : "Approve linked actual costs"}</Button>
      </form>
    </DialogContent></Dialog>
  </section>
}
export function WarrantyReserveEstimate({ projectId }: { projectId: string }) {
  const [pending,startTransition] = useTransition()
  return <details className="border p-3"><summary className="cursor-pointer text-sm font-medium">Warranty reserve estimate</summary><p className="my-2 text-xs text-muted-foreground">Before sale, the approved estimate posts at closing. After sale, entering a new estimate adjusts the remaining reserve to that amount.</p><form className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => {
    const amountCents = parseMoneyToCents(String(data.get("amount") ?? "")); if (amountCents === null) { toast.error("Enter a valid estimate"); return }
    const result = await setWarrantyReserveEstimateAction({ projectId, amountCents, date: String(data.get("date") ?? ""), evidenceUrl: String(data.get("evidenceUrl") ?? "") }); if (!result.success) { toast.error(result.error); return } toast.success("Warranty estimate recorded")
  }) }}>{([['amount','Expected remaining warranty cost','text'],['date','Estimate date','date'],['evidenceUrl','Approved estimate URL','url']] as const).map(([name,label,type]) => <div className="space-y-1" key={name}><Label htmlFor={`reserve-${name}`}>{label}</Label><Input id={`reserve-${name}`} name={name} type={type} required /></div>)}<Button type="submit" disabled={pending}>Save approved estimate</Button></form></details>
}
