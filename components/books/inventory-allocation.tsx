"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { allocateDevelopmentInventoryAction, capitalizeInventoryInterestAction, loadInventoryAllocationWorkspaceAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseMoneyToCents } from "@/lib/financials/money-input"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getInventoryAllocationWorkspace>>
export function InventoryAllocation({ projectId }: { projectId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [mode, setMode] = useState<"development" | "interest" | null>(null)
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState([{ lotId: "", amount: "" }])
  const open = (next: "development" | "interest") => startTransition(async () => { const result = await loadInventoryAllocationWorkspaceAction(); if (!result.success) { toast.error(result.error); return } setWorkspace(result.data); setMode(next) })
  return <><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={() => open("development")}>Allocate shared development cost</Button><Button variant="outline" disabled={pending} onClick={() => open("interest")}>Capitalize eligible interest</Button></div>
    <Dialog open={mode !== null} onOpenChange={value => { if (!value) setMode(null) }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{mode === "development" ? "Allocate recorded development costs" : "Capitalize incurred interest"}</DialogTitle><DialogDescription>{mode === "development" ? "Transfer costs from this development project to acquired lots using an approved allocation schedule." : "Select actual interest already posted. Record only the eligible amount supported by the capitalization policy and construction period."}</DialogDescription></DialogHeader>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => {
        try {
          const money = (value: string) => { const amount = parseMoneyToCents(value); if (amount === null) throw new Error("Enter a valid amount"); return amount }
          const base = { projectId, date: String(data.get("date") ?? ""), reference: String(data.get("reference") ?? ""), evidenceUrl: String(data.get("evidenceUrl") ?? "") }
          const result = mode === "development" ? await allocateDevelopmentInventoryAction({ ...base, allocations: rows.map(row => ({ lotId: row.lotId, amountCents: money(row.amount) })) }) : await capitalizeInventoryInterestAction({ ...base, sourceLineId: String(data.get("sourceLineId") ?? ""), amountCents: money(String(data.get("amount") ?? "")) })
          if (!result.success) { toast.error(result.error); return } toast.success("Inventory journal recorded"); setMode(null)
        } catch (error) { toast.error(error instanceof Error ? error.message : "Check the allocation") }
      }) }}>
        {mode === "development" ? <>{rows.map((row,index) => <div className="grid grid-cols-2 gap-2" key={index}><Select value={row.lotId} onValueChange={lotId => setRows(current => current.map((item,i) => i===index ? {...item,lotId} : item))}><SelectTrigger aria-label={`Receiving lot ${index+1}`}><SelectValue placeholder="Receiving lot" /></SelectTrigger><SelectContent>{workspace?.lots.map(lot => <SelectItem key={lot.id} value={lot.id}>{lot.name}</SelectItem>)}</SelectContent></Select><Input aria-label={`Allocated amount ${index+1}`} value={row.amount} placeholder="Allocated cost" required onChange={event => { const amount = event.target.value; setRows(current => current.map((item,i) => i===index ? {...item,amount} : item)) }} /></div>)}<Button type="button" variant="ghost" onClick={() => setRows(current => [...current,{lotId:"",amount:""}])}>Add receiving lot</Button></> : <><Select name="sourceLineId" required><SelectTrigger aria-label="Incurred interest"><SelectValue placeholder="Select incurred interest" /></SelectTrigger><SelectContent>{workspace?.interest.map(line => <SelectItem key={line.id} value={line.id}>{line.label} · {(line.amountCents/100).toFixed(2)}</SelectItem>)}</SelectContent></Select><Label htmlFor="inventory-interest-amount">Eligible amount</Label><Input id="inventory-interest-amount" name="amount" required inputMode="decimal" /></>}
        {([['date','Accounting date','date'],['reference','Unique allocation reference','text'],['evidenceUrl','Approved supporting schedule URL','url']] as const).map(([name,label,type]) => <div className="space-y-1" key={name}><Label htmlFor={`allocation-${name}`}>{label}</Label><Input id={`allocation-${name}`} name={name} type={type} required /></div>)}
        <Button type="submit" disabled={pending}>{pending ? "Recording…" : "Record approved allocation"}</Button>
      </form>
    </DialogContent></Dialog></>
}
