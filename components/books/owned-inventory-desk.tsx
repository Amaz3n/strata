"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { reviewDevelopmentAllocationAction, reviewInventoryImpairmentAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Desk = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getOwnedInventoryDesk>>
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const BASES: Record<string, string> = { equal: "Equal per lot", front_footage: "Front footage", square_footage: "Square footage", sales_value: "Sales value", custom: "Custom schedule" }

/**
 * Homes the builder owns, read from the ledger, and the accounting judgments on
 * them waiting for a second member. Approving here runs the same action as on
 * the home.
 */
export function OwnedInventoryDesk({ desk }: { desk: Desk }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const decide = (kind: "impairment" | "allocation", id: string, approve: boolean) => startTransition(async () => {
    const note = approve ? "" : window.prompt("Why is this rejected?") ?? ""
    if (!approve && note.trim().length < 10) { toast.error("Say why it is rejected"); return }
    const result = kind === "impairment"
      ? await reviewInventoryImpairmentAction({ impairmentId: id, approve, note: note || undefined })
      : await reviewDevelopmentAllocationAction({ allocationId: id, approve, note: note || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(approve ? (kind === "impairment" ? "Write-down approved and posted" : "Allocation approved and posted") : "Rejected")
    router.refresh()
  })
  const actions = (kind: "impairment" | "allocation", id: string, preparedBy: string) => preparedBy === desk.userId
    ? <p className="text-xs text-muted-foreground">Another member approves it.</p>
    : desk.canReview && <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => decide(kind, id, true)}>{kind === "impairment" ? "Approve write-down" : "Approve and post"}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(kind, id, false)}>Reject</Button></div>
  const waiting = desk.impairments.length + desk.allocations.length
  return <div className="space-y-6">
    <p className="max-w-3xl text-sm text-muted-foreground">Homes the builder owns, as the ledger carries them. Write-downs and land allocations are prepared on the home or development and approved here by a second member.</p>

    <section aria-label="Waiting for approval" className="space-y-2">
      <h2 className="text-sm font-medium">Waiting for approval{waiting > 0 && <span className="ml-2 text-warning">{waiting}</span>}</h2>
      {!waiting ? <p className="border px-3 py-8 text-center text-sm text-muted-foreground">Nothing is waiting for approval.</p> : <ul className="divide-y border">
        {desk.impairments.map(row => <li key={row.id} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><span><span className="font-medium">Write-down</span> · {row.name}</span>
            <span className="tabular-nums font-medium text-destructive">{money(row.writeDownCents)}</span></div>
          <p className="tabular-nums text-xs text-muted-foreground">As of {row.asOf}: cost {money(row.carryingCents)} · value {money(row.netRealizableCents)} ({money(row.sellingPriceCents)} − {money(row.costToCompleteCents)} to finish − {money(row.costToSellCents)} to sell)</p>
          <p className="text-xs text-muted-foreground">{row.assumptions} · <a className="underline" href={row.evidenceUrl} target="_blank" rel="noreferrer">evidence</a></p>
          {actions("impairment", row.id, row.preparedBy)}
        </li>)}
        {desk.allocations.map(row => <li key={row.id} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><span><span className="font-medium">Land allocation</span> · {row.name} · {row.reference}</span><span className="tabular-nums font-medium">{money(row.totalCents)}</span></div>
          <p className="text-xs text-muted-foreground">{BASES[row.basis] ?? row.basis} · {row.shares.map(share => `${share.lot} ${money(share.cents)}`).join(" · ")}</p>
          <p className="text-xs text-muted-foreground">{row.note}</p>
          {actions("allocation", row.id, row.preparedBy)}
        </li>)}
      </ul>}
      {desk.truncated && <p className="text-xs text-muted-foreground">Showing the oldest {waiting} waiting; approve these to see the rest.</p>}
    </section>

    <section aria-label="Completed homes held for sale" className="space-y-2">
      <h2 className="text-sm font-medium">Completed homes held for sale</h2>
      {!desk.held.length ? <p className="border px-3 py-8 text-center text-sm text-muted-foreground">No completed home is waiting to sell.</p> : <div className="overflow-x-auto border">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Home</th><th className="px-3 py-2 font-medium">Completed</th><th className="px-3 py-2 text-right font-medium">Days held</th><th className="px-3 py-2 text-right font-medium">Cost</th></tr></thead>
          <tbody>{desk.held.map(row => <tr key={row.projectId} className="border-b last:border-0">
            <td className="px-3 py-2">{row.name}</td>
            <td className="px-3 py-2 tabular-nums">{row.completedOn}</td>
            <td className={cn("px-3 py-2 text-right tabular-nums", row.ageDays > 90 ? "text-destructive" : row.ageDays > 60 ? "text-warning" : undefined)}>{row.ageDays}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(row.cents)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>
}
