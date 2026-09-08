"use client"

import Link from "next/link"
import * as React from "react"

import { listPaymentRunsAction } from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { PaymentRunListRow } from "@/lib/services/payment-runs"

function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100) }

export function PaymentRunsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [runs, setRuns] = React.useState<PaymentRunListRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const load = React.useCallback(async () => {
    setLoading(true); setError(null)
    const result = await listPaymentRunsAction()
    if (result.success) setRuns(result.data)
    else setError(result.error)
    setLoading(false)
  }, [])
  React.useEffect(() => { if (open) void load() }, [open, load])
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4 text-left">
          <SheetTitle>Payment history</SheetTitle>
          <SheetDescription>Approval and money-movement history. Open a run for its frozen evidence.</SheetDescription>
        </SheetHeader>
        {loading ? <div className="space-y-0 divide-y" aria-label="Loading payment runs">{Array.from({ length: 7 }).map((_, index) => <div key={index} className="grid grid-cols-[1fr_7rem] gap-4 p-4"><Skeleton className="h-8"/><Skeleton className="h-8"/></div>)}</div>
          : error ? <div role="alert" className="m-5 border border-destructive/40 p-4 text-sm"><p className="text-destructive">{error}</p><Button className="mt-3 rounded-none" variant="outline" size="sm" onClick={() => void load()}>Try again</Button></div>
          : runs.length === 0 ? <div className="p-10 text-center"><p className="text-sm font-medium">No payment runs yet</p><p className="mt-1 text-xs text-muted-foreground">Approved payables will appear here after a run is created.</p></div>
          : <div className="divide-y">{runs.map((run) => <Link key={run.id} href={`/payables/payment-runs/${run.id}`} onClick={() => onOpenChange(false)} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-3 hover:bg-muted/30"><div className="min-w-0"><p className="truncate text-sm font-medium capitalize">{run.status.replaceAll("_", " ")}</p><p className="mt-0.5 text-xs text-muted-foreground">{run.payment_count} {run.payment_count === 1 ? "bill" : "bills"} · {run.approvals.filter((approval) => approval.decision === "approved").length}/{run.required_approvals} approvals · {new Date(run.created_at).toLocaleDateString()}</p></div><span className="font-mono text-sm tabular-nums">{money(run.total_debit_cents)}</span></Link>)}</div>}
      </SheetContent>
    </Sheet>
  )
}
