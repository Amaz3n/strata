"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { capitalizeInventoryInterestAction, loadInventoryAllocationWorkspaceAction, proposeDevelopmentAllocationAction, reviewDevelopmentAllocationAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseMoneyToCents } from "@/lib/financials/money-input"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getInventoryAllocationWorkspace>>
const BASES = [["equal", "Equal per lot"], ["front_footage", "Front footage"], ["square_footage", "Square footage"], ["sales_value", "Sales value"], ["custom", "Custom schedule"]] as const
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

/**
 * Shared development cost reaches lots through a reviewed allocation: a basis,
 * each lot's weight and the total. Arc splits it to the cent; a different member
 * approves it before anything posts.
 */
export function InventoryAllocation({ projectId }: { projectId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [mode, setMode] = useState<"development" | "interest" | null>(null)
  const [pending, startTransition] = useTransition()
  const [basis, setBasis] = useState<(typeof BASES)[number][0]>("equal")
  const [rows, setRows] = useState([{ lotId: "", weight: "1" }])
  const open = (next: "development" | "interest") => startTransition(async () => { const result = await loadInventoryAllocationWorkspaceAction(projectId); if (!result.success) { toast.error(result.error); return } setWorkspace(result.data); setMode(next) })
  const review = (allocationId: string, approve: boolean) => startTransition(async () => {
    const note = approve ? "" : window.prompt("Why is this allocation rejected?") ?? ""
    if (!approve && note.trim().length < 10) { toast.error("Say why the allocation is rejected"); return }
    const result = await reviewDevelopmentAllocationAction({ allocationId, approve, note: note || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(approve ? "Allocation approved and posted" : "Allocation rejected")
    const reloaded = await loadInventoryAllocationWorkspaceAction(projectId); if (reloaded.success) setWorkspace(reloaded.data)
  })
  const proposals = workspace?.pending.filter(row => row.projectId === projectId) ?? []
  return <><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={() => open("development")}>Allocate shared development cost</Button><Button variant="outline" disabled={pending} onClick={() => open("interest")}>Capitalize eligible interest</Button></div>
    <Dialog open={mode !== null} onOpenChange={value => { if (!value) setMode(null) }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{mode === "development" ? "Allocate shared development cost" : "Capitalize incurred interest"}</DialogTitle><DialogDescription>{mode === "development" ? "Choose the basis and each lot's share of it. Arc splits the total to the cent; another member approves it before it posts." : "Select actual interest already posted. Record only the eligible amount supported by the capitalization policy and construction period."}</DialogDescription></DialogHeader>
      {mode === "development" && proposals.length > 0 && <section aria-label="Waiting for approval" className="space-y-2 border p-3 text-sm">
        <p className="font-medium">Waiting for approval</p>
        {proposals.map(row => <div key={row.id} className="space-y-1 border-t pt-2 first:border-0 first:pt-0">
          <p>{row.reference} · {BASES.find(([value]) => value === row.basis)?.[1]} · {money(row.totalCents)}</p>
          <p className="text-xs text-muted-foreground">{row.shares.map(share => `${share.lot} ${money(share.cents)}`).join(" · ")}</p>
          <p className="text-xs text-muted-foreground">{row.note}</p>
          {row.preparedBy === workspace?.userId ? <p className="text-xs text-muted-foreground">Another member approves it.</p> : <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => review(row.id, true)}>Approve and post</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => review(row.id, false)}>Reject</Button></div>}
        </div>)}
      </section>}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => {
        try {
          const cents = (value: string) => { const amount = parseMoneyToCents(value); if (amount === null) throw new Error("Enter a valid amount"); return amount }
          const base = { projectId, date: String(data.get("date") ?? ""), reference: String(data.get("reference") ?? ""), evidenceUrl: String(data.get("evidenceUrl") ?? "") }
          const result = mode === "development"
            ? await proposeDevelopmentAllocationAction({ ...base, basis, totalCents: cents(String(data.get("total") ?? "")), note: String(data.get("note") ?? ""),
                weights: rows.map(row => ({ lotId: row.lotId, weight: basis === "equal" ? 1 : Number(row.weight) })) })
            : await capitalizeInventoryInterestAction({ ...base, sourceLineId: String(data.get("sourceLineId") ?? ""), amountCents: cents(String(data.get("amount") ?? "")) })
          if (!result.success) { toast.error(result.error); return }
          toast.success(mode === "development" ? "Allocation proposed. Another member approves it." : "Inventory journal recorded")
          if (mode === "development") { const reloaded = await loadInventoryAllocationWorkspaceAction(projectId); if (reloaded.success) setWorkspace(reloaded.data) } else setMode(null)
        } catch (error) { toast.error(error instanceof Error ? error.message : "Check the allocation") }
      }) }}>
        {mode === "development" ? <>
          <div className="space-y-1"><Label htmlFor="allocation-basis">Basis</Label><Select value={basis} onValueChange={value => { const next = BASES.find(([key]) => key === value); if (next) setBasis(next[0]) }}><SelectTrigger id="allocation-basis"><SelectValue /></SelectTrigger><SelectContent>{BASES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="allocation-total">Total to allocate</Label><Input id="allocation-total" name="total" inputMode="decimal" required /></div>
          {workspace?.lots.length === 0 ? <p className="text-xs text-warning">No lot can receive this job&apos;s cost yet. Link the job to the phases it develops on the community&apos;s Land tab.</p> : null}
          {rows.map((row, index) => <div className="grid grid-cols-2 gap-2" key={index}><Select value={row.lotId} onValueChange={lotId => setRows(current => current.map((item, i) => i === index ? { ...item, lotId } : item))}><SelectTrigger aria-label={`Receiving lot ${index + 1}`}><SelectValue placeholder="Receiving lot" /></SelectTrigger><SelectContent>{workspace?.lots.map(lot => <SelectItem key={lot.id} value={lot.id}>{lot.name}</SelectItem>)}</SelectContent></Select>
            {basis === "equal" ? <span className="self-center text-xs text-muted-foreground">Equal share</span> : <Input aria-label={`Basis for lot ${index + 1}`} inputMode="decimal" value={row.weight} onChange={event => { const weight = event.target.value; setRows(current => current.map((item, i) => i === index ? { ...item, weight } : item)) }} />}</div>)}
          <Button type="button" variant="ghost" onClick={() => setRows(current => [...current, { lotId: "", weight: "1" }])}>Add receiving lot</Button>
          <div className="space-y-1"><Label htmlFor="allocation-note">Why this basis</Label><Textarea id="allocation-note" name="note" rows={2} required minLength={10} /></div>
        </> : <><Select name="sourceLineId" required><SelectTrigger aria-label="Incurred interest"><SelectValue placeholder="Select incurred interest" /></SelectTrigger><SelectContent>{workspace?.interest.map(line => <SelectItem key={line.id} value={line.id}>{line.label} · {(line.amountCents / 100).toFixed(2)}</SelectItem>)}</SelectContent></Select><Label htmlFor="inventory-interest-amount">Eligible amount</Label><Input id="inventory-interest-amount" name="amount" required inputMode="decimal" /></>}
        {([["date", "Accounting date", "date"], ["reference", "Unique allocation reference", "text"], ["evidenceUrl", "Supporting schedule URL", "url"]] as const).map(([name, label, type]) => <div className="space-y-1" key={name}><Label htmlFor={`allocation-${name}`}>{label}</Label><Input id={`allocation-${name}`} name={name} type={type} required /></div>)}
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : mode === "development" ? "Propose allocation" : "Record approved allocation"}</Button>
      </form>
    </DialogContent></Dialog></>
}
