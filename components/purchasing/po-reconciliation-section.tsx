"use client"

import { useEffect, useState } from "react"

import { getProjectPoPositionsAction } from "@/app/(app)/purchasing/vpo-actions"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { PO_POSITION_EXCEPTION_LABELS, poRemainingCents, poRevisedCents } from "@/lib/purchasing/po-position"
import type { PoPositionRow } from "@/lib/services/po-positions"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; row: PoPositionRow | null }

/** What a purchase order authorizes against what has been billed and paid, and where the two disagree. */
export function PoReconciliationSection({ projectId, commitmentId }: { projectId: string; commitmentId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    setState({ kind: "loading" })
    getProjectPoPositionsAction(projectId).then((result) => {
      if (cancelled) return
      if (!result.success) setState({ kind: "error", message: result.error })
      else setState({ kind: "ready", row: result.data.rows.find((row) => row.commitmentId === commitmentId) ?? null })
    }).catch(() => { if (!cancelled) setState({ kind: "error", message: "Unable to load the reconciliation." }) })
    return () => { cancelled = true }
  }, [projectId, commitmentId])

  return (
    <div className="space-y-2 border-t pt-3">
      <div>
        <h4 className="text-sm font-semibold">Reconciliation</h4>
        <p className="text-xs text-muted-foreground">Approved including variance orders, billed, paid and held as retainage.</p>
      </div>
      {state.kind === "loading" && <Skeleton className="h-16 w-full" />}
      {state.kind === "error" && <p className="border border-dashed px-3 py-4 text-sm text-destructive">{state.message}</p>}
      {state.kind === "ready" && !state.row && <p className="border border-dashed px-3 py-4 text-sm text-muted-foreground">Positions appear once the purchase order is approved.</p>}
      {state.kind === "ready" && state.row && (
        <>
          <dl className="grid grid-cols-2 gap-px border bg-border text-xs sm:grid-cols-4 lg:grid-cols-7">
            {[
              ["Original", state.row.originalCents],
              ["Approved VPOs", state.row.approvedVpoCents],
              ["Revised total", poRevisedCents(state.row)],
              ["Billed", state.row.billedCents],
              ["Paid", state.row.paidCents],
              ["Retainage held", state.row.retainageHeldCents],
              ["Left to bill", poRemainingCents(state.row)],
            ].map(([label, cents]) => (
              <div key={String(label)} className="bg-background px-3 py-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">{money(Number(cents))}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {state.row.exceptions.map((exception) => (
              <Badge key={exception.kind} variant="destructive" className="rounded-none">{PO_POSITION_EXCEPTION_LABELS[exception.kind]} · {money(exception.cents)}</Badge>
            ))}
            {state.row.exceptions.length === 0 && <span className="text-xs text-success">Books agree with this order.</span>}
            {state.row.pendingVpoCount > 0 && <span className="text-xs text-muted-foreground">{state.row.pendingVpoCount} variance {state.row.pendingVpoCount === 1 ? "order" : "orders"} awaiting approval</span>}
          </div>
        </>
      )}
    </div>
  )
}
