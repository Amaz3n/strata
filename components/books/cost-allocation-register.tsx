"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { proposeCostAllocationAction, reviewCostAllocationAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { cn } from "@/lib/utils"

type Register = Awaited<ReturnType<typeof import("@/lib/services/books/cost-allocations").getCostAllocationRegister>>
type Allocation = Register["allocations"][number]
type Pool = Allocation["pool"]
type Basis = Allocation["basis"]
const POOLS: Array<[Pool, string]> = [["equipment", "Equipment"], ["overhead", "Overhead"], ["insurance", "Insurance"], ["supervision", "Supervision"], ["other", "Other"]]
const BASES: Array<[Basis, string]> = [["equal", "Equal per job"], ["labor_hours", "Labor hours"], ["direct_cost", "Direct cost"], ["equipment_hours", "Equipment hours"], ["custom", "Custom schedule"]]
const STATUS: Record<Allocation["status"], [string, string]> = {
  proposed: ["Waiting for review", "text-warning"], approved: ["Posted", "text-success"], rejected: ["Rejected", "text-muted-foreground"], reallocated: ["Reallocated", "text-muted-foreground"],
}
const RETAINED = "retained"
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/**
 * Shared cost and where it went. Each pool is what an expense account holds on
 * no job; an allocation spreads part of it across jobs on a stated basis, split
 * to the cent and approved by a second member. A reallocation reverses the
 * original and posts the new split; both stay on record.
 */
export function CostAllocationRegister({ register }: { register: Register }) {
  const [proposing, setProposing] = useState<{ correcting: Allocation | null } | null>(null)
  const waiting = register.allocations.filter(row => row.status === "proposed").length
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl space-y-1">
        <p className="text-sm text-muted-foreground">Equipment, overhead, insurance and supervision cost reaches jobs only through an allocation a second member approves. An allocation can move no more than its pool holds, so the same cost is never allocated twice; costs already on a job are never in a pool.</p>
        {waiting > 0 && <p className="text-sm text-warning">{waiting} {waiting === 1 ? "allocation is" : "allocations are"} waiting for review.</p>}
      </div>
      {register.canPropose && <Button variant="outline" disabled={!register.pools.length} onClick={() => setProposing({ correcting: null })}>Allocate a pool</Button>}
    </div>

    <section aria-label="Pools" className="space-y-2">
      <h2 className="text-sm font-medium">Unallocated pools</h2>
      <div className="overflow-x-auto border">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Account</th><th className="px-3 py-2 text-right font-medium">On no job today</th></tr></thead>
          <tbody>
            {register.pools.map(pool => <tr key={pool.accountId} className="border-b last:border-0"><td className="px-3 py-2">{pool.label}</td><td className="px-3 py-2 text-right tabular-nums">{money(pool.cents)}</td></tr>)}
            {!register.pools.length && <tr><td colSpan={2} className="px-3 py-8 text-center text-muted-foreground">No company expense is waiting to be allocated.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <section aria-label="Allocations" className="space-y-2">
      <h2 className="text-sm font-medium">Allocations</h2>
      {!register.allocations.length ? <p className="border px-3 py-10 text-center text-sm text-muted-foreground">No allocations yet.</p> : <div className="overflow-x-auto border">
        <table className="w-full min-w-[900px] text-sm">
          <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Allocation</th><th className="px-3 py-2 font-medium">Pool</th><th className="px-3 py-2 font-medium">Shares</th>
            <th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 font-medium">Review</th><th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {register.allocations.map(row => <AllocationRow key={row.id} row={row} register={register} onReallocate={() => setProposing({ correcting: row })} />)}
          </tbody>
        </table>
      </div>}
      {register.truncated && <p className="text-xs text-muted-foreground">Showing the newest {register.allocations.length} of {register.total} allocations.</p>}
    </section>
    {proposing && <ProposeAllocation register={register} correcting={proposing.correcting} onClose={() => setProposing(null)} />}
  </div>
}

function AllocationRow({ row, register, onReallocate }: { row: Allocation; register: Register; onReallocate: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const review = (approve: boolean) => startTransition(async () => {
    const note = approve ? "" : window.prompt("Why is this allocation rejected?") ?? ""
    if (!approve && note.trim().length < 10) { toast.error("Say why the allocation is rejected"); return }
    const result = await reviewCostAllocationAction({ allocationId: row.id, approve, note: note || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(approve ? "Allocation approved and posted" : "Allocation rejected"); router.refresh()
  })
  const [label, tone] = STATUS[row.status]
  const correcting = row.correctsId ? register.allocations.find(other => other.id === row.correctsId) : null
  return <tr className="border-b align-top last:border-0">
    <td className="px-3 py-2.5"><p className="font-medium">{row.reference}</p><p className="text-xs text-muted-foreground">{date(row.date)} · {BASES.find(([value]) => value === row.basis)?.[1]}</p>
      {correcting && <p className="text-xs text-muted-foreground">Reallocates {correcting.reference}</p>}
      <p className="max-w-72 text-xs text-muted-foreground">{row.note}</p></td>
    <td className="px-3 py-2.5"><p>{POOLS.find(([value]) => value === row.pool)?.[1]}</p><p className="text-xs text-muted-foreground">{row.account}{row.costCode ? ` → ${row.costCode}` : ""}</p></td>
    <td className="px-3 py-2.5"><ul className="space-y-0.5">{row.shares.map(share => <li key={share.projectId ?? RETAINED} className="flex justify-between gap-4 text-xs"><span className={cn(!share.projectId && "text-muted-foreground")}>{share.name}</span><span className="tabular-nums">{money(share.cents)}</span></li>)}</ul></td>
    <td className="px-3 py-2.5 text-right tabular-nums">{money(row.totalCents)}</td>
    <td className="px-3 py-2.5"><p className={cn("text-xs font-medium", tone)}>{label}</p>
      <p className="text-xs text-muted-foreground">Prepared by {row.preparedByName}{row.reviewedByName ? ` · reviewed by ${row.reviewedByName}` : ""}</p>
      {row.reviewNote && <p className="max-w-56 text-xs text-muted-foreground">{row.reviewNote}</p>}
      {row.status === "proposed" && (row.preparedBy === register.userId
        ? <p className="text-xs text-muted-foreground">Another member approves it.</p>
        : register.canReview && <div className="mt-1 flex gap-2"><Button size="sm" disabled={pending} onClick={() => review(true)}>Approve and post</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => review(false)}>Reject</Button></div>)}</td>
    <td className="px-3 py-2.5 text-right">{register.canPropose && row.status === "approved" && <Button size="sm" variant="outline" onClick={onReallocate}>Reallocate</Button>}</td>
  </tr>
}

function ProposeAllocation({ register, correcting, onClose }: { register: Register; correcting: Allocation | null; onClose: () => void }) {
  const prefix = useId()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [pool, setPool] = useState<Pool>(correcting?.pool ?? "overhead")
  const [basis, setBasis] = useState<Basis>(correcting?.basis ?? "equal")
  const [accountId, setAccountId] = useState(correcting?.sourceAccountId ?? register.pools[0]?.accountId ?? "")
  const [costCodeId, setCostCodeId] = useState(correcting?.costCodeId ?? "")
  const [total, setTotal] = useState(correcting ? String(correcting.totalCents / 100) : "")
  const [rows, setRows] = useState(correcting ? correcting.shares.map(share => ({ projectId: share.projectId ?? RETAINED, weight: String(share.weight) })) : [{ projectId: "", weight: "1" }])
  const [today] = useState(() => new Date().toISOString().slice(0, 10))
  const [allocationDate, setAllocationDate] = useState(today)
  const [reference, setReference] = useState(correcting ? `${correcting.reference} (reallocated)` : "")
  const [evidenceUrl, setEvidenceUrl] = useState(correcting?.evidenceUrl ?? "")
  const [note, setNote] = useState("")
  const accounts = correcting ? [{ accountId: correcting.sourceAccountId, label: correcting.account }] : register.pools
  const submit = () => startTransition(async () => {
    const totalCents = parseMoneyToCents(total)
    if (totalCents === null || totalCents <= 0) { toast.error("Enter the amount to allocate"); return }
    if (rows.some(row => !row.projectId)) { toast.error("Choose each destination"); return }
    const result = await proposeCostAllocationAction({
      date: allocationDate, reference, pool, basis, sourceAccountId: accountId, costCodeId: costCodeId || null, totalCents, evidenceUrl, note, correctsId: correcting?.id ?? null,
      weights: rows.map(row => ({ projectId: row.projectId === RETAINED ? null : row.projectId, weight: basis === "equal" ? 1 : Number(row.weight) })),
    })
    if (!result.success) { toast.error(result.error); return }
    toast.success("Allocation proposed. Another member approves it."); onClose(); router.refresh()
  })
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{correcting ? `Reallocate ${correcting.reference}` : "Allocate a shared cost pool"}</DialogTitle>
        <DialogDescription>{correcting ? "Approval reverses the original allocation and posts this one. Both stay on record." : "Arc splits the total to the cent on the basis you choose. Another member approves it before it posts."}</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor={`${prefix}-pool`}>Kind of cost</Label>
            <select id={`${prefix}-pool`} className="w-full border bg-background p-2 text-sm" value={pool} onChange={event => { const next = POOLS.find(([value]) => value === event.target.value); if (next) setPool(next[0]) }}>
              {POOLS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="space-y-1"><Label htmlFor={`${prefix}-account`}>From account</Label>
            <select id={`${prefix}-account`} className="w-full border bg-background p-2 text-sm" value={accountId} disabled={Boolean(correcting)} onChange={event => setAccountId(event.target.value)}>
              {accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.label}{"cents" in account ? ` · ${money(account.cents)}` : ""}</option>)}</select></div>
          <div className="space-y-1"><Label htmlFor={`${prefix}-total`}>Amount to allocate</Label><Input id={`${prefix}-total`} inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={`${prefix}-code`}>Job cost code</Label>
            <select id={`${prefix}-code`} className="w-full border bg-background p-2 text-sm" value={costCodeId} onChange={event => setCostCodeId(event.target.value)}>
              <option value="">No cost code</option>{register.costCodes.map(code => <option key={code.id} value={code.id}>{code.label}</option>)}</select></div>
          <div className="space-y-1"><Label htmlFor={`${prefix}-basis`}>Basis</Label>
            <select id={`${prefix}-basis`} className="w-full border bg-background p-2 text-sm" value={basis} onChange={event => { const next = BASES.find(([value]) => value === event.target.value); if (next) setBasis(next[0]) }}>
              {BASES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="space-y-1"><Label htmlFor={`${prefix}-date`}>Accounting date</Label><Input id={`${prefix}-date`} type="date" value={allocationDate} onChange={event => setAllocationDate(event.target.value)} /></div>
        </div>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">Destinations</legend>
          {rows.map((row, index) => <div key={index} className="grid grid-cols-[1fr_8rem] gap-2">
            <select aria-label={`Destination ${index + 1}`} className="w-full border bg-background p-2 text-sm" value={row.projectId} onChange={event => { const projectId = event.target.value; setRows(current => current.map((item, i) => i === index ? { ...item, projectId } : item)) }}>
              <option value="">Choose a job</option><option value={RETAINED}>Retain as company overhead</option>
              {register.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
            {basis === "equal" ? <span className="self-center text-xs text-muted-foreground">Equal share</span>
              : <Input aria-label={`Basis for destination ${index + 1}`} inputMode="decimal" value={row.weight} onChange={event => { const weight = event.target.value; setRows(current => current.map((item, i) => i === index ? { ...item, weight } : item)) }} />}
          </div>)}
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows(current => [...current, { projectId: "", weight: "1" }])}>Add destination</Button>
          {register.projectsTruncated && <p className="text-xs text-muted-foreground">Showing the first {register.projects.length} jobs.</p>}
        </fieldset>
        <div className="space-y-1"><Label htmlFor={`${prefix}-reference`}>Unique reference</Label><Input id={`${prefix}-reference`} value={reference} onChange={event => setReference(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${prefix}-evidence`}>Supporting schedule URL</Label><Input id={`${prefix}-evidence`} type="url" value={evidenceUrl} onChange={event => setEvidenceUrl(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${prefix}-note`}>Why this basis</Label><Textarea id={`${prefix}-note`} rows={2} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={pending || note.trim().length < 10 || reference.trim().length < 3 || !evidenceUrl || !accountId} onClick={submit}>{pending ? "Proposing…" : "Propose allocation"}</Button></div>
      </div>
    </DialogContent>
  </Dialog>
}
