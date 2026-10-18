"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { resolveSaleCancellationPickAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import type { SaleCancellationReviewItem } from "@/lib/services/sale-cancellation-picks"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

/**
 * Purchase orders on released homes whose sale was cancelled, still carrying
 * the previous buyer's options and design picks. Keep leaves them for the spec
 * home; Cancel takes them off (an issued order gets a variance order to approve).
 */
export function SaleCancellationPicksBand({ items, total }: { items: SaleCancellationReviewItem[]; total: number }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  if (total === 0) return null

  function decide(item: SaleCancellationReviewItem, decision: "keep" | "cancel") {
    setBusy(item.commitmentId)
    startTransition(async () => {
      const result = await resolveSaleCancellationPickAction({ commitment_id: item.commitmentId, decision }, item.projectId)
      setBusy(null)
      if (!result.success) { toast.error(result.error); return }
      toast.success(decision === "keep" ? "Picks kept for the spec home"
        : result.data.varianceOrderId ? "Variance order raised to remove the picks" : "Picks removed from the draft order")
      router.refresh()
    })
  }

  return (
    <section aria-labelledby="sale-cancellation-picks" className="border-b bg-warning/5 px-4 py-3">
      <h2 id="sale-cancellation-picks" className="text-sm font-medium">
        {total} purchase {total === 1 ? "order carries" : "orders carry"} a cancelled buyer&apos;s picks
      </h2>
      <p className="text-xs text-muted-foreground">The homes keep building as spec homes. Keep the picks, or cancel them off the order.</p>
      <ul className="mt-2 divide-y">
        {items.map((item) => (
          <li key={item.commitmentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-xs">
            <Link className="min-w-0 font-medium underline underline-offset-4" href={`/projects/${item.projectId}/financials/budget`}>
              {item.projectName} · {item.poNumber ?? "Purchase order"}
            </Link>
            <span className="text-muted-foreground">{item.vendor}{item.issued ? " · issued" : " · draft"}</span>
            <span className="min-w-0 flex-1 truncate">{item.lines.map((line) => line.description).join(", ")}</span>
            <span className="tabular-nums">{money(item.totalCents)}</span>
            <span className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(item, "keep")}>
                {busy === item.commitmentId ? "Saving…" : "Keep"}
              </Button>
              <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => decide(item, "cancel")}>
                Cancel picks
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {total > items.length && <p className="mt-1 text-xs text-muted-foreground">Showing {items.length} of {total}.</p>}
    </section>
  )
}
