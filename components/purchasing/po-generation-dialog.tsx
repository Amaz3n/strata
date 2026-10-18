"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { generatePurchaseOrdersAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { PurchasingEntityPicker, type PurchasingEntity } from "@/components/purchasing/entity-picker"
import { PoGenerationPreview } from "@/components/purchasing/po-generation-preview"
import type { PoGenerationResult } from "@/lib/services/po-generation"

/**
 * Preview, then generate, one home's purchase orders. The Purchasing desk asks
 * for the home; a project's own panel passes it in.
 */
export function PoGenerationDialog({ project }: { project?: PurchasingEntity } = {}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [home, setHome] = useState<PurchasingEntity | null>(project ?? null)
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
        if (mode === "commit") router.refresh()
      } catch {
        setError("Unable to confirm the result. Retry to recover the generation run.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next) }}>
    <DialogTrigger asChild><Button size="sm">Generate purchase orders</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Generate purchase orders</DialogTitle><DialogDescription>{project ? `Preview vendor pricing, scope, expiring agreements and exceptions before generating ${project.name}'s purchase orders.` : "Choose a home and preview vendor pricing, scope, expiring agreements and exceptions before generating its purchase orders."}</DialogDescription></DialogHeader>
      {!project && <PurchasingEntityPicker kind="home" value={home} disabled={pending} onChange={(next) => { setHome(next); setResult(null); setError(null) }} />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <PoGenerationPreview result={result} />}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending || !home} onClick={() => run("dry_run")}>{pending ? "Working…" : "Preview orders"}</Button>
        <Button disabled={pending || !home || result?.mode !== "dry_run"} onClick={() => run("commit")}>Generate orders</Button>
      </div>
    </DialogContent>
  </Dialog>
}
