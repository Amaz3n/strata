"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { acquireLandInventoryAction, correctLandStartTransferAction, loadLandAcquisitionWorkspaceAction, reverseLandAcquisitionAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { formatMoneyCents } from "@/lib/utils"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getLandAcquisitionWorkspace>>
export function LandAcquisition() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState([{ lotId: "", amount: "" }])
  const [correcting, setCorrecting] = useState(false)
  const [kind, setKind] = useState<"acquisition" | "start">("acquisition")
  const [target, setTarget] = useState("")
  const load = () => startTransition(async () => { const result = await loadLandAcquisitionWorkspaceAction(); if (!result.success) { toast.error(result.error); return } setWorkspace(result.data) })
  const targets = kind === "acquisition" ? workspace?.acquisitions.map(row => ({ id: row.entryId, label: `${row.date} · ${row.memo} · ${row.lots.map(lot => `${lot.name} ${formatMoneyCents(lot.amountCents)}`).join(", ")}` })) : workspace?.startTransfers.map(row => ({ id: row.lotId, label: `${row.date} · ${row.name}` }))
  return <><Button variant="outline" disabled={pending} onClick={() => startTransition(async () => { const result = await loadLandAcquisitionWorkspaceAction(); if (!result.success) { toast.error(result.error); return } setWorkspace(result.data); setOpen(true) })}>Record land acquisition</Button>
    <Button variant="ghost" disabled={pending} onClick={() => { load(); setTarget(""); setCorrecting(true) }}>Correct a land entry</Button>
    <Dialog open={correcting} onOpenChange={setCorrecting}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Correct a land entry</DialogTitle><DialogDescription>Reversing keeps the original entry and posts its reversal. A reversed acquisition releases its lots so the right acquisition can be recorded; a reversed start transfer can be posted again on a new date.</DialogDescription></DialogHeader>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => {
        const date = String(data.get("date") ?? ""), reason = String(data.get("reason") ?? "")
        const result = kind === "acquisition" ? await reverseLandAcquisitionAction({ entryId: target, date, reason }) : await correctLandStartTransferAction({ lotId: target, reversalDate: date, reason, repostDate: String(data.get("repostDate") ?? "") || null })
        if (!result.success) { toast.error(result.error); return } toast.success("Reversal recorded"); setCorrecting(false); load()
      }) }}>
        <div className="space-y-1"><Label htmlFor="correct-kind">Entry</Label><Select value={kind} onValueChange={value => { setKind(value === "start" ? "start" : "acquisition"); setTarget("") }}><SelectTrigger id="correct-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="acquisition">Land acquisition</SelectItem><SelectItem value="start">Start transfer</SelectItem></SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="correct-target">Which entry</Label><Select value={target} onValueChange={setTarget}><SelectTrigger id="correct-target"><SelectValue placeholder={targets?.length === 0 ? "Nothing to correct" : "Select an entry"} /></SelectTrigger><SelectContent>{targets?.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectContent></Select></div>
        {workspace?.correctionsTruncated ? <p className="text-xs text-muted-foreground">Showing the {workspace.correctionCap} most recent entries.</p> : null}
        {([['date','Reversal date','date',true],['reason','Reason','text',true]] as const).map(([name,label,type,required]) => <div className="space-y-1" key={name}><Label htmlFor={`correct-${name}`}>{label}</Label><Input id={`correct-${name}`} name={name} type={type} required={required} minLength={name === "reason" ? 5 : undefined} /></div>)}
        {kind === "start" ? <div className="space-y-1"><Label htmlFor="correct-repostDate">Post again on (optional)</Label><Input id="correct-repostDate" name="repostDate" type="date" /></div> : null}
        <Button type="submit" disabled={pending || !target}>{pending ? "Reversing…" : kind === "start" ? "Reverse start transfer" : "Reverse acquisition"}</Button>
      </form>
    </DialogContent></Dialog>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Record acquired land</DialogTitle><DialogDescription>Allocate the actual settlement cost to each lot. Funding must equal those allocations. Debt funding also updates its loan register.</DialogDescription></DialogHeader>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => {
        try {
          const money = (value: string) => { const cents = parseMoneyToCents(value); if (cents === null) throw new Error("Enter valid acquisition amounts"); return cents }
          const result = await acquireLandInventoryAction({ date: String(data.get("date") ?? ""), allocations: rows.map(row => ({ lotId: row.lotId, amountCents: money(row.amount) })), cashCents: money(String(data.get("cash") || "0")), debtCents: money(String(data.get("debt") || "0")), cashAccountId: String(data.get("cashAccountId") || "") || null, debtInstrumentId: data.get("debtInstrumentId") === "none" ? null : String(data.get("debtInstrumentId") || "") || null, reference: String(data.get("reference") ?? ""), evidenceUrl: String(data.get("evidenceUrl") ?? "") })
          if (!result.success) { toast.error(result.error); return } toast.success("Acquisition and lot ownership recorded"); setOpen(false); setRows([{lotId:"",amount:""}])
        } catch (error) { toast.error(error instanceof Error ? error.message : "Check acquisition details") }
      }) }}>
        {rows.map((row,index) => <div className="grid grid-cols-2 gap-2" key={index}><Select value={row.lotId} onValueChange={lotId => setRows(current => current.map((item,i) => i === index ? {...item,lotId} : item))}><SelectTrigger aria-label={`Acquired lot ${index+1}`}><SelectValue placeholder="Lot" /></SelectTrigger><SelectContent>{workspace?.lots.map(lot => <SelectItem key={lot.id} value={lot.id}>{lot.name}</SelectItem>)}</SelectContent></Select><Input aria-label={`Actual cost for lot ${index+1}`} placeholder="Actual allocated cost" inputMode="decimal" required value={row.amount} onChange={event => { const amount = event.target.value; setRows(current => current.map((item,i) => i === index ? {...item,amount} : item)) }} /></div>)}
        <Button type="button" variant="ghost" size="sm" onClick={() => setRows(current => [...current,{lotId:"",amount:""}])}>Add lot</Button>
        <div className="space-y-1"><Label htmlFor="land-bank">Bank funding</Label><Select name="cashAccountId"><SelectTrigger id="land-bank"><SelectValue placeholder="Actual bank account" /></SelectTrigger><SelectContent>{workspace?.accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.code} · {account.name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="land-loan">Loan funding</Label><Select name="debtInstrumentId" defaultValue="none"><SelectTrigger id="land-loan"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No loan funding</SelectItem>{workspace?.debt.map(instrument => <SelectItem key={instrument.id} value={instrument.id}>{instrument.name}</SelectItem>)}</SelectContent></Select></div>
        {([['cash','Cash paid','text'],['debt','Loan proceeds applied','text'],['date','Acquisition date','date'],['reference','Settlement reference','text'],['evidenceUrl','Settlement statement URL','url']] as const).map(([name,label,type]) => <div className="space-y-1" key={name}><Label htmlFor={`land-${name}`}>{label}</Label><Input id={`land-${name}`} name={name} type={type} required defaultValue={name==='cash'||name==='debt'?'0':undefined} /></div>)}
        <Button type="submit" disabled={pending || !workspace?.lots.length}>{pending ? "Recording…" : "Record actual acquisition"}</Button>
      </form>
    </DialogContent></Dialog></>
}
