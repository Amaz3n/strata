"use client"

import Link from "next/link"
import { useCallback, useEffect, useState, useTransition } from "react"
import { PackageCheck, RefreshCw } from "lucide-react"

import { generateProjectPurchaseOrdersAction, loadProjectPoGenerationAction } from "@/app/(app)/projects/[id]/financials/actions"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import { useToast } from "@/hooks/use-toast"

export function PoGenerationPanel({ projectId }: { projectId: string }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<{ lastRun: Record<string, unknown> | null; openExceptions: number } | null>(null)
  const reload = useCallback(() => loadProjectPoGenerationAction(projectId).then((result) => { if (result.success) setState(result.data as typeof state) }), [projectId])
  useEffect(() => { void reload() }, [reload])
  const run = (mode: "dry_run" | "commit") => startTransition(async () => {
    try {
      const result = unwrapAction(await generateProjectPurchaseOrdersAction(projectId, mode))
      toast({ title: mode === "dry_run" ? "PO dry run complete" : "Purchase orders generated", description: `${result.purchaseOrders.length} vendor PO${result.purchaseOrders.length === 1 ? "" : "s"}, ${result.exceptions.length} exception${result.exceptions.length === 1 ? "" : "s"}.` })
      await reload()
    } catch (error) { toast({ title: "PO generation failed", description: (error as Error).message, variant: "destructive" }) }
  })
  const lastStatus = typeof state?.lastRun?.status === "string" ? state.lastRun.status.replaceAll("_", " ") : "No prior run"
  return <div className="flex flex-wrap items-center gap-3 border-b bg-muted/15 px-6 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">Lot purchase-order generation</div><div className="text-xs capitalize text-muted-foreground">{lastStatus}{state ? ` · ${state.openExceptions} open exceptions` : ""}</div></div>{Boolean(state?.openExceptions) && <Button asChild size="sm" variant="ghost"><Link href={`/purchasing?tab=exceptions&project=${projectId}`}>Review exceptions</Link></Button>}<Button size="sm" variant="outline" disabled={pending} onClick={() => run("dry_run")}><RefreshCw /> Dry run</Button><Button size="sm" disabled={pending} onClick={() => run("commit")}><PackageCheck /> Generate POs</Button></div>
}
