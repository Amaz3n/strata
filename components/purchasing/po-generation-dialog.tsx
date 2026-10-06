"use client"

import { useState, useTransition } from "react"
import { generatePurchaseOrdersAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { PurchasingEntityPicker, type PurchasingEntity } from "@/components/purchasing/entity-picker"
import type { PoGenerationResult } from "@/lib/services/po-generation"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

export function PoGenerationDialog() {
  const [open, setOpen] = useState(false)
  const [home, setHome] = useState<PurchasingEntity | null>(null)
  const [result, setResult] = useState<PoGenerationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run(mode: "dry_run" | "commit") {
    if (!home) return
    setError(null)
    startTransition(async () => {
      try {
        const response = await generatePurchaseOrdersAction({ projectId: home.id, mode, expectedFingerprint: mode === "commit" ? result?.inputFingerprint : undefined })
        if (!response.success) { setError(response.error); return }
        setResult(response.data)
        if (response.data.status === "failed") setError("Generation failed. Review the exceptions before retrying.")
      } catch {
        setError("Unable to confirm the result. Retry to recover the generation run.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next) }}>
    <DialogTrigger asChild><Button size="sm">Generate purchase orders</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Generate purchase orders</DialogTitle><DialogDescription>Choose a home and preview vendor pricing, scope, and exceptions before generating its purchase orders.</DialogDescription></DialogHeader>
      <PurchasingEntityPicker kind="home" value={home} disabled={pending} onChange={(next) => { setHome(next); setResult(null); setError(null) }} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <div className="space-y-3" aria-live="polite">
        <p className="text-sm font-medium">{result.mode === "dry_run" ? "Preview" : "Generation result"} · {result.purchaseOrders.length} purchase orders · {result.exceptions.length} exceptions</p>
        {result.purchaseOrders.map((po) => <details key={po.companyId} className="border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{po.companyName} · {po.lines.length} lines · {money(po.totalCents)}</summary>
          <ul className="mt-2 divide-y">{po.lines.map((line) => <li key={`${line.sourceKind}:${line.sourceId}`} className="flex justify-between gap-4 py-2"><span>{line.description}<span className="block text-xs text-muted-foreground">{line.quantity} {line.unit} × {money(line.unitCostCents)}</span></span><span className="tabular-nums">{money(line.totalCents)}</span></li>)}</ul>
        </details>)}
        {result.exceptions.length > 0 && <div className="border border-destructive/40 p-3 text-sm"><p className="font-medium">These lines cannot be ordered yet</p><ul className="mt-2 space-y-2">{result.exceptions.map((item, index) => <li key={`${item.source_kind}:${index}`}>{item.description}<span className="block text-xs text-muted-foreground">{item.reason.replaceAll("_", " ")}</span></li>)}</ul><p className="mt-3 text-xs">Generating creates the priceable orders and leaves these exceptions in the purchasing queue.</p></div>}
        {result.expiringAgreements.length > 0 && <p className="text-sm text-warning">{result.expiringAgreements.length} price agreements expire soon. Review their effective dates before ordering.</p>}
        {result.mode === "commit" && result.status !== "failed" && <p className="text-sm text-success">Purchase order generation completed{result.exceptions.length ? " with exceptions" : ""}.</p>}
      </div>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending || !home} onClick={() => run("dry_run")}>{pending ? "Working…" : "Preview orders"}</Button>
        <Button disabled={pending || !home || result?.mode !== "dry_run" || result.status === "failed"} onClick={() => run("commit")}>Generate orders</Button>
      </div>
    </DialogContent>
  </Dialog>
}
