"use client"

/**
 * Send measured conditions to a money surface.
 *
 * Two steps, always: pick a destination, then read the diff. The diff is not a
 * formality — it is the only thing standing between a re-measure and silently
 * overwriting a number an estimator typed on purpose. Lines flagged `drift`
 * are excluded by default and require an explicit "overwrite" per condition.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ArrowRight, Loader2, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import { formatQuantity, MEASURE_UOM_LABELS, type MeasureUom } from "@/lib/drawings/measure"
import type { ConditionRollup, ConditionSyncPreviewRow } from "@/lib/services/takeoff"
import type { TakeoffSyncTarget } from "@/lib/services/takeoff-destinations"
import type { TakeoffDestination } from "@/lib/validation/takeoff"
import {
  listPlanVersionTargetAction,
  listSyncTargetsAction,
  previewConditionSyncAction,
  syncConditionsAction,
} from "@/app/(app)/drawings/takeoff-actions"

const DESTINATION_LABELS: Record<TakeoffDestination, string> = {
  estimate: "Estimate",
  bid_scope: "Bid package",
  plan_takeoff: "Plan takeoff",
}

export interface TakeoffSyncDialogProps {
  open: boolean
  /** Exactly one, mirroring the condition's own scope. */
  projectId?: string | null
  housePlanVersionId?: string | null
  rollups: ConditionRollup[]
  onOpenChange: (open: boolean) => void
  onSynced: () => void
}

export function TakeoffSyncDialog({
  open,
  projectId,
  housePlanVersionId,
  rollups,
  onOpenChange,
  onSynced,
}: TakeoffSyncDialogProps) {
  const [targets, setTargets] = useState<TakeoffSyncTarget[] | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TakeoffSyncTarget | null>(null)
  const [preview, setPreview] = useState<ConditionSyncPreviewRow[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [overwrites, setOverwrites] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)

  const conditionIds = useMemo(() => rollups.map((r) => r.condition.id), [rollups])

  useEffect(() => {
    let cancelled = false
    // A plan-version takeoff has exactly one destination — its own version —
    // so there is nothing to choose between.
    const load = housePlanVersionId
      ? listPlanVersionTargetAction(housePlanVersionId)
      : projectId
        ? listSyncTargetsAction(projectId)
        : Promise.resolve({ success: true as const, data: [] as TakeoffSyncTarget[] })
    load
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setTargets(result.data)
          // One writable destination is the common case; skip the pick.
          const writable = result.data.filter((target) => target.writable)
          if (writable.length === 1) setSelected(writable[0])
        } else {
          setTargetsError(result.error)
          setTargets([])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTargetsError("Failed to load destinations")
          setTargets([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId, housePlanVersionId])

  useEffect(() => {
    if (!selected) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    previewConditionSyncAction({
      destination: selected.destination,
      target_id: selected.id,
      condition_ids: conditionIds,
    })
      .then((result) => {
        if (cancelled) return
        if (result.success) setPreview(result.data)
        else toast.error(result.error)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, conditionIds])

  const driftRows = useMemo(
    () => (preview ?? []).filter((row) => row.action === "drift"),
    [preview],
  )
  const writeCount = useMemo(() => {
    if (!preview) return 0
    return preview.filter(
      (row) =>
        row.action === "create" ||
        row.action === "update" ||
        (row.action === "drift" && overwrites.has(row.condition_id)),
    ).length
  }, [preview, overwrites])

  const handleSync = useCallback(async () => {
    if (!selected) return
    setSyncing(true)
    try {
      const result = unwrapAction(
        await syncConditionsAction({
          destination: selected.destination,
          target_id: selected.id,
          condition_ids: conditionIds,
          drift_resolution: Object.fromEntries(
            Array.from(overwrites).map((id) => [id, "overwrite" as const]),
          ),
        }),
      )
      const parts: string[] = []
      if (result.created) parts.push(`${result.created} added`)
      if (result.updated) parts.push(`${result.updated} updated`)
      if (result.unchanged) parts.push(`${result.unchanged} already current`)
      if (result.skipped) parts.push(`${result.skipped} left alone`)
      toast.success(`${selected.label}: ${parts.join(" · ") || "nothing to do"}`)
      onSynced()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send")
    } finally {
      setSyncing(false)
    }
  }, [selected, conditionIds, overwrites, onSynced])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send {rollups.length} condition{rollups.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Quantities are written with a link back to the measurement, so a re-measure can update
            them later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="microlabel">Destination</div>
            {targets === null ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Finding destinations…
              </div>
            ) : targets.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                {targetsError ??
                  (housePlanVersionId
                    ? "This plan version can't accept lines — it may already be released."
                    : "This project has no estimate or bid package to send to yet. Create one first.")}
              </p>
            ) : (
              <ScrollArea className="max-h-40">
                <ul className="divide-y border">
                  {targets.map((target) => (
                    <li key={`${target.destination}-${target.id}`}>
                      <button
                        type="button"
                        disabled={!target.writable}
                        onClick={() => setSelected(target)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors",
                          target.writable ? "hover:bg-muted/50" : "cursor-not-allowed opacity-55",
                          selected?.id === target.id && "bg-muted",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">{target.label}</div>
                          <div className="text-[11px] capitalize text-muted-foreground">
                            {DESTINATION_LABELS[target.destination]}
                            {target.detail ? ` · ${target.detail}` : ""}
                          </div>
                        </div>
                        {!target.writable && target.blocked_reason && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {target.blocked_reason}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>

          {selected && (
            <div className="space-y-1.5">
              <div className="microlabel">What changes</div>
              {previewing ? (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Comparing…
                </div>
              ) : (
                <ScrollArea className="max-h-64">
                  <table className="w-full border text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="microlabel px-2.5 py-1.5 text-left font-semibold">Condition</th>
                        <th className="microlabel px-2.5 py-1.5 text-right font-semibold">On the line</th>
                        <th className="microlabel px-2.5 py-1.5 text-right font-semibold">Measured</th>
                        <th className="microlabel px-2.5 py-1.5 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(preview ?? []).map((row) => (
                        <tr key={row.condition_id}>
                          <td className="px-2.5 py-1.5">
                            <div className="truncate">{row.condition_name}</div>
                            {row.action === "drift" && (
                              <div className="mt-0.5 text-[11px] text-warning">
                                Hand-edited since the last sync (was{" "}
                                {formatQuantity(row.last_synced_quantity ?? 0)})
                              </div>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
                            {row.current_quantity === null ? "—" : formatQuantity(row.current_quantity)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">
                            {formatQuantity(row.next_quantity)}{" "}
                            <span className="text-[11px] text-muted-foreground">
                              {MEASURE_UOM_LABELS[row.uom as MeasureUom]}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            <ActionCell
                              row={row}
                              overwriting={overwrites.has(row.condition_id)}
                              onToggleOverwrite={() =>
                                setOverwrites((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(row.condition_id)) next.delete(row.condition_id)
                                  else next.add(row.condition_id)
                                  return next
                                })
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              )}

              {driftRows.length > 0 && (
                <p className="flex items-start gap-1.5 pt-1 text-[11px] text-warning">
                  <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                  {driftRows.length} line{driftRows.length === 1 ? "" : "s"} changed after the last
                  sync. They stay as they are unless you choose to overwrite.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={syncing}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSync()}
            disabled={!selected || previewing || syncing || writeCount === 0}
          >
            {syncing && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {writeCount === 0 ? "Nothing to write" : `Write ${writeCount} line${writeCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ActionCell({
  row,
  overwriting,
  onToggleOverwrite,
}: {
  row: ConditionSyncPreviewRow
  overwriting: boolean
  onToggleOverwrite: () => void
}) {
  if (row.action === "create") {
    return (
      <Badge variant="outline" className="h-5 gap-1 font-normal">
        <ArrowRight className="h-3 w-3" />
        Add
      </Badge>
    )
  }
  if (row.action === "update") {
    return (
      <Badge variant="outline" className="h-5 gap-1 font-normal">
        <ArrowRight className="h-3 w-3" />
        Update
      </Badge>
    )
  }
  if (row.action === "unchanged") {
    return <span className="text-[11px] text-muted-foreground">Already current</span>
  }
  return (
    <Button
      size="sm"
      variant={overwriting ? "destructive" : "outline"}
      className="h-6 text-[11px]"
      onClick={onToggleOverwrite}
    >
      {overwriting ? "Will overwrite" : "Keep the edit"}
    </Button>
  )
}
