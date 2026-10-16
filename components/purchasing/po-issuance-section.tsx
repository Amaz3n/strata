"use client"

import { useEffect, useState } from "react"

import { getPoIssuanceAction } from "@/app/(app)/projects/[id]/commitments/actions"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { PO_ACK_STATE_LABELS } from "@/lib/purchasing/po-acknowledgment-state"
import type { PoIssuance } from "@/lib/services/po-acknowledgments"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

const REASON_LABELS: Record<string, string> = {
  backfill: "Existing order", approved: "Approved", reapproved: "Approved again", vpo_approved: "Variance order approved", vpo_voided: "Variance order voided",
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; issuance: PoIssuance }

/** What was issued to the vendor, in which revision, and how the vendor answered it. */
export function PoIssuanceSection({ commitmentId }: { commitmentId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    setState({ kind: "loading" })
    getPoIssuanceAction(commitmentId).then((result) => {
      if (cancelled) return
      setState(result.success ? { kind: "ready", issuance: result.data } : { kind: "error", message: result.error })
    }).catch(() => { if (!cancelled) setState({ kind: "error", message: "Unable to load the issued version." }) })
    return () => { cancelled = true }
  }, [commitmentId])

  const current = state.kind === "ready" ? state.issuance.current : null
  const disputed = current?.state === "disputed"
  return (
    <div className="space-y-2 border-t pt-3">
      <div>
        <h4 className="text-sm font-semibold">Issued version and acknowledgment</h4>
        <p className="text-xs text-muted-foreground">What the vendor was issued and how they answered. Terms change by variance order, or by returning the order to draft.</p>
      </div>
      {state.kind === "loading" && <Skeleton className="h-16 w-full" />}
      {state.kind === "error" && <p className="border border-dashed px-3 py-4 text-sm text-destructive">{state.message}</p>}
      {state.kind === "ready" && !current && <p className="border border-dashed px-3 py-4 text-sm text-muted-foreground">The order is issued to the vendor when it is approved.</p>}
      {current && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Revision {current.revision}</span>
            <Badge variant={disputed ? "destructive" : current.state === "accepted" ? "secondary" : "outline"} className="rounded-none">{PO_ACK_STATE_LABELS[current.state]}</Badge>
            <span className="text-xs text-muted-foreground">Issued {day(current.issuedAt)} · vendor held to <span className="tabular-nums">{money(current.revisedObligationCents)}</span></span>
          </div>
          {current.warning && <p className="border border-warning/40 bg-warning/5 px-3 py-2 text-xs">{current.warning} Completion and payment are not held up by this.</p>}
          {current.answer?.reason && <p className="whitespace-pre-wrap border-l-2 pl-3 text-xs text-muted-foreground">{current.answer.reason}</p>}
          {current.changes.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{current.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
          {state.kind === "ready" && state.issuance.history.length > 1 && (
            <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {state.issuance.history.map((row) => <li key={row.revision}>Rev {row.revision} · {REASON_LABELS[row.reason] ?? row.reason} · {day(row.issuedAt)}</li>)}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
