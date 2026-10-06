"use client"

/**
 * The two things a drawing revision can do to a takeoff, surfaced where the
 * numbers are.
 *
 * 1. Measurements were carried onto the new revision and are waiting on a
 *    human. They are NOT counted until confirmed, so the panel's totals are
 *    understated until this band is cleared — which is why it sits above the
 *    list rather than behind a tab.
 * 2. A quantity moved on something already under a signed estimate. That is a
 *    change-order conversation, and the band says so with a number.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowRight, Check, Loader2, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import { formatQuantity } from "@/lib/drawings/measure"
import type { ReanchorReviewItem, StaleEstimateAlert } from "@/lib/services/takeoff-reanchor"
import {
  confirmReanchoredMarkupsAction,
  listReanchorReviewQueueAction,
  listStaleEstimateAlertsAction,
} from "@/app/(app)/drawings/takeoff-actions"

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

export interface TakeoffRevisionBandProps {
  projectId: string
  refreshToken: number
  canWrite: boolean
  onResolved: () => void
  /** Walk the queue on the sheet, one measurement at a time. */
  onReview: (items: ReanchorReviewItem[]) => void
}

export function TakeoffRevisionBand({
  projectId,
  refreshToken,
  canWrite,
  onResolved,
  onReview,
}: TakeoffRevisionBandProps) {
  const [review, setReview] = useState<ReanchorReviewItem[]>([])
  const [alerts, setAlerts] = useState<StaleEstimateAlert[]>([])
  const [confirming, setConfirming] = useState(false)

  const [alertError, setAlertError] = useState<string | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [loadingQueue, setLoadingQueue] = useState(true)
  const [queueProject, setQueueProject] = useState<string | null>(null)
  const loadGeneration = useRef(0)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoadingQueue(true)
    setQueueProject(null)
    setQueueError(null)
    setReview([])
    setAlerts([])
    setAlertError(null)
    const [queue, stale] = await Promise.allSettled([
      listReanchorReviewQueueAction(projectId).then(unwrapAction),
      listStaleEstimateAlertsAction(projectId).then(unwrapAction),
    ])
    if (generation !== loadGeneration.current) return
    setQueueProject(projectId)
    if (queue.status === "fulfilled") setReview(queue.value)
    else setQueueError(queue.reason instanceof Error ? queue.reason.message : "Failed to load measurements awaiting review")
    if (stale.status === "fulfilled") setAlerts(stale.value)
    else setAlertError(stale.reason instanceof Error ? stale.reason.message : "Failed to load signed-estimate changes")
    setLoadingQueue(false)
  }, [projectId])

  useEffect(() => {
    void load()
    return () => { loadGeneration.current += 1 }
  }, [load, refreshToken])

  const handleConfirmAll = useCallback(async (unchangedOnly = false) => {
    if (!canWrite || queueProject !== projectId || loadingQueue || queueError || review.length === 0) return
    setConfirming(true)
    try {
      const count = unwrapAction(
        await confirmReanchoredMarkupsAction(review.filter((item) => !unchangedOnly || item.evidence_comparison === "unchanged").map((item) => item.markup_id)),
      )
      toast.success(`${count} measurement${count === 1 ? "" : "s"} confirmed`)
      onResolved()
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to confirm")
    } finally {
      setConfirming(false)
    }
  }, [canWrite, queueProject, projectId, loadingQueue, queueError, review, onResolved, load])

  if (queueProject !== projectId || loadingQueue) return (
    <div className="px-4 pt-1">
      <div role="status" className="flex items-center justify-between gap-2 border border-warning/50 px-3 py-2 text-xs">
        <span>Loading revision review and signed-estimate changes…</span>
      </div>
    </div>
  )
  if (!queueError && !alertError && review.length === 0 && alerts.length === 0) return null

  // Sheets, not markups: "3 measurements" means nothing to an estimator, but
  // "A-101, A-102" tells them exactly where to look.
  const sheetNumbers = Array.from(new Set(review.map((item) => item.sheet_number))).sort()

  return (
    <div className="space-y-2 px-4 pt-1">
      {(queueError || alertError) && <div role="alert" className="flex items-center justify-between gap-2 border border-warning/50 px-3 py-2 text-xs">
        <div>{queueError && <p>Revision review: {queueError}</p>}{alertError && <p>Signed-estimate changes: {alertError}</p>}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()}>Retry</Button>
      </div>}
      {review.length > 0 && (
        <div className="space-y-2 border border-warning/50 bg-warning/10 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <div className="min-w-0 text-xs">
              <p className="font-medium">
                {review.length} measurement{review.length === 1 ? "" : "s"} moved to a new revision
              </p>
              <p className="mt-0.5 text-muted-foreground">
                On {sheetNumbers.slice(0, 4).join(", ")}
                {sheetNumbers.length > 4 ? ` +${sheetNumbers.length - 4} more` : ""}. They
                don&apos;t count toward totals until you check them against the new drawing.
                {" "}{review.filter((i) => i.evidence_comparison === "unchanged").length} have unchanged local vector evidence;
                {" "}{review.filter((i) => i.evidence_comparison === "changed").length} have changed evidence. Others need manual comparison.
              </p>
            </div>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2 pl-5.5">
              <Button size="sm" className="h-7 text-xs" disabled={confirming} onClick={() => onReview(review)}>
                Review {review.length}
              </Button>
              {review.some((i) => i.evidence_comparison === "unchanged") && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={confirming} onClick={() => void handleConfirmAll(true)}>Confirm unchanged</Button>}
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() => void handleConfirmAll()}
                disabled={confirming}
              >
                {confirming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Confirm all {review.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {alerts.map((alert) => (
        <div key={`${alert.condition_id}:${alert.estimate_id}:${alert.estimate_line_id}`} className="border border-warning/50 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <div className="min-w-0 text-xs">
              <p className="font-medium">
                {alert.condition_name} moved {alert.delta_quantity > 0 ? "+" : ""}
                <span className="tabular-nums">
                  {formatQuantity(alert.delta_quantity)} {alert.uom.toUpperCase()}
                </span>
                {alert.delta_cents !== null && (
                  <>
                    {" "}
                    ≈{" "}
                    <span className="tabular-nums">
                      {alert.delta_cents > 0 ? "+" : ""}
                      {money(alert.delta_cents)}
                    </span>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                &ldquo;{alert.estimate_title}&rdquo; is signed at{" "}
                <span className="tabular-nums">{formatQuantity(alert.synced_quantity)}</span>.
              </p>
              <a
                href={alert.change_order_href}
                className="mt-1 inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline"
              >
                Draft a change order
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
