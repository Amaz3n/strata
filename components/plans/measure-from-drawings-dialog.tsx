"use client"

/**
 * "Measure from drawings" — the production entry into takeoff.
 *
 * A house plan has no drawing set of its own; drawings live on projects. What a
 * plan has is lots built from it, and those lots' projects carry its sheets. So
 * this picks a built house to measure against, and the resulting conditions
 * belong to the PLAN VERSION — the quantities roll up to the plan no matter
 * which lot they were traced on.
 *
 * The paste importer stays. Spreadsheets are a real workflow, and a plan is
 * allowed to get its bill either way; the release gate counts lines, not their
 * provenance.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowRight, Loader2, Ruler } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { PlanDrawingSource } from "@/lib/services/takeoff-destinations"
import { listPlanDrawingSourcesAction } from "@/app/(app)/drawings/takeoff-actions"

export interface MeasureFromDrawingsDialogProps {
  open: boolean
  housePlanId: string
  housePlanVersionId: string
  onOpenChange: (open: boolean) => void
}

export function MeasureFromDrawingsDialog({
  open,
  housePlanId,
  housePlanVersionId,
  onOpenChange,
}: MeasureFromDrawingsDialogProps) {
  const [sources, setSources] = useState<PlanDrawingSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSources(null)
    setError(null)
    listPlanDrawingSourcesAction(housePlanId)
      .then((result) => {
        if (cancelled) return
        if (result.success) setSources(result.data)
        else {
          setError(result.error)
          setSources([])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Couldn't load drawings for this plan")
          setSources([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, housePlanId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Measure from drawings</DialogTitle>
          <DialogDescription>
            Pick a house built from this plan. What you measure there rolls up to this plan
            version, not to that job.
          </DialogDescription>
        </DialogHeader>

        {sources === null ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Finding drawings…
          </div>
        ) : sources.length === 0 ? (
          <div className="space-y-2 py-6 text-sm">
            <p className="font-medium">No drawings to measure yet</p>
            <p className="text-muted-foreground">
              {error ??
                "No lot built from this plan has published drawings. Upload a plan set to one of its jobs, or paste the takeoff from a spreadsheet instead."}
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="divide-y border">
              {sources.map((source) => (
                <li key={source.project_id}>
                  <Link
                    href={`/projects/${source.project_id}/drawings?planVersion=${housePlanVersionId}`}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
                    onClick={() => onOpenChange(false)}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{source.project_name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {[source.community_name, source.lot_label].filter(Boolean).join(" · ") ||
                          "Project"}
                        {" · "}
                        <span className="tabular-nums">{source.sheet_count}</span> sheet
                        {source.sheet_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Toolbar trigger for the plan bill. */
export function MeasureFromDrawingsButton({
  housePlanId,
  housePlanVersionId,
}: {
  housePlanId: string
  housePlanVersionId: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 rounded-none px-2 text-[11px]"
        onClick={() => setOpen(true)}
      >
        <Ruler className="mr-1 h-3.5 w-3.5" />
        Measure
      </Button>
      <MeasureFromDrawingsDialog
        open={open}
        housePlanId={housePlanId}
        housePlanVersionId={housePlanVersionId}
        onOpenChange={setOpen}
      />
    </>
  )
}
