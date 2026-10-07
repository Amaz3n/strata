"use client"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { loadInventoryImpairmentWorkspaceAction, proposeInventoryImpairmentAction, reviewInventoryImpairmentAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { cn } from "@/lib/utils"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getInventoryImpairmentWorkspace>>
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const STATUS = { proposed: ["Waiting for review", "text-warning"], approved: ["Written down", "text-destructive"], rejected: ["Rejected", "text-muted-foreground"] } as const

/**
 * A home worth less than it cost is written down to net realizable value: the
 * expected price less the cost to finish and to sell it. One member prepares
 * the review, another approves it; the write-down becomes the home's cost and is
 * never written back up.
 */
export function InventoryImpairment({ projectId }: { projectId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ asOf: "", price: "", complete: "", sell: "", evidenceUrl: "", assumptions: "" })
  const load = () => startTransition(async () => {
    const result = await loadInventoryImpairmentWorkspaceAction(projectId)
    if (!result.success) { toast.error(result.error); return }
    setWorkspace(result.data)
  })
  const cents = (value: string) => parseMoneyToCents(value || "0")
  const [price, complete, sell] = [cents(form.price), cents(form.complete), cents(form.sell)]
  const netRealizable = price !== null && complete !== null && sell !== null ? price - complete - sell : null
  const writeDown = workspace && netRealizable !== null ? workspace.carryingCents - netRealizable : null
  const review = (impairmentId: string, approve: boolean) => startTransition(async () => {
    const note = approve ? "" : window.prompt("Why is this review rejected?") ?? ""
    if (!approve && note.trim().length < 10) { toast.error("Say why the review is rejected"); return }
    const result = await reviewInventoryImpairmentAction({ impairmentId, approve, note: note || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(approve ? "Write-down approved and posted" : "Review rejected")
    const reloaded = await loadInventoryImpairmentWorkspaceAction(projectId); if (reloaded.success) setWorkspace(reloaded.data)
  })
  const prepare = () => startTransition(async () => {
    if (price === null || complete === null || sell === null) { toast.error("Enter valid amounts"); return }
    const result = await proposeInventoryImpairmentAction({ projectId, asOf: form.asOf, sellingPriceCents: price, costToCompleteCents: complete, costToSellCents: sell, evidenceUrl: form.evidenceUrl, assumptions: form.assumptions })
    if (!result.success) { toast.error(result.error); return }
    toast.success("Review prepared. Another member approves it.")
    setForm({ asOf: "", price: "", complete: "", sell: "", evidenceUrl: "", assumptions: "" })
    const reloaded = await loadInventoryImpairmentWorkspaceAction(projectId); if (reloaded.success) setWorkspace(reloaded.data)
  })
  const field = (key: keyof typeof form, label: string, type = "text") => <div className="space-y-1"><Label htmlFor={`impairment-${key}`}>{label}</Label>
    <Input id={`impairment-${key}`} type={type} inputMode={type === "text" ? "decimal" : undefined} value={form[key]} onChange={event => { const value = event.target.value; setForm(current => ({ ...current, [key]: value })) }} /></div>
  const waiting = workspace?.reviews.some(row => row.status === "proposed")
  return <details className="border p-3" onToggle={event => { if (event.currentTarget.open && !workspace) load() }}>
    <summary className="cursor-pointer text-sm font-medium">Impairment review</summary>
    <p className="my-2 text-xs text-muted-foreground">When the home is worth less than it cost, write it down to the expected price less the cost to finish and to sell it. Another member approves the write-down; it becomes the home&apos;s cost and is not written back up.</p>
    {!workspace ? <div className="h-24 animate-pulse bg-muted/40" /> : <div className="space-y-3 text-sm">
      <p>Cost carried today <span className="tabular-nums font-medium">{money(workspace.carryingCents)}</span></p>
      {workspace.reviews.length > 0 && <ul className="divide-y border">{workspace.reviews.map(row => { const [label, tone] = STATUS[row.status]; return <li key={row.id} className="space-y-1 p-2">
        <div className="flex flex-wrap justify-between gap-2"><span className={cn("text-xs font-medium", tone)}>{label}</span><span className="text-xs text-muted-foreground">As of {row.asOf}</span></div>
        <p className="tabular-nums text-xs">Cost {money(row.carryingCents)} · value {money(row.netRealizableCents)} ({money(row.sellingPriceCents)} − {money(row.costToCompleteCents)} to finish − {money(row.costToSellCents)} to sell) · write-down <span className="font-medium">{money(row.writeDownCents)}</span></p>
        <p className="text-xs text-muted-foreground">{row.assumptions}</p>
        {row.reviewNote && <p className="text-xs text-muted-foreground">{row.reviewNote}</p>}
        {row.status === "proposed" && (row.preparedBy === workspace.userId ? <p className="text-xs text-muted-foreground">Another member approves it.</p>
          : <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => review(row.id, true)}>Approve write-down</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => review(row.id, false)}>Reject</Button></div>)}
      </li> })}</ul>}
      {!waiting && <div className="space-y-3 border-t pt-3">
        <div className="grid gap-3 sm:grid-cols-2">{field("asOf", "Review date", "date")}{field("price", "Expected selling price")}{field("complete", "Cost to complete")}{field("sell", "Cost to sell")}</div>
        {netRealizable !== null && writeDown !== null && <p className="tabular-nums text-xs">Net realizable value {money(netRealizable)} · {writeDown > 0 ? <span className="text-destructive">write-down {money(writeDown)}</span> : <span className="text-success">covers today&apos;s cost; no write-down</span>}</p>}
        {field("evidenceUrl", "Valuation evidence URL", "url")}
        <div className="space-y-1"><Label htmlFor="impairment-assumptions">Assumptions</Label><Textarea id="impairment-assumptions" rows={2} value={form.assumptions} onChange={event => { const value = event.target.value; setForm(current => ({ ...current, assumptions: value })) }} /></div>
        <Button size="sm" disabled={pending || !form.asOf || !form.evidenceUrl || form.assumptions.trim().length < 10} onClick={prepare}>{pending ? "Saving…" : "Prepare review"}</Button>
      </div>}
    </div>}
  </details>
}
