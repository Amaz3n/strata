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

import { useCallback, useEffect, useState } from "react"
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
}

export function TakeoffRevisionBand({
  projectId,
  refreshToken,
  canWrite,
  onResolved,
}: TakeoffRevisionBandProps) {
  const [review, setReview] = useState<ReanchorReviewItem[]>([])
  const [alerts, setAlerts] = useState<StaleEstimateAlert[]>([])
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    const [queue, stale] = await Promise.all([
      listReanchorReviewQueueAction(projectId).catch(() => []),
      listStaleEstimateAlertsAction(projectId).catch(() => []),
    ])
    setReview(queue)
    setAlerts(stale)
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const handleConfirmAll = useCallback(async () => {
    if (review.length === 0) return
    setConfirming(true)
    try {
      const count = unwrapAction(
        await confirmReanchoredMarkupsAction(review.map((item) => item.markup_id)),
      )
      toast.success(`${count} measurement${count === 1 ? "" : "s"} confirmed`)
      onResolved()
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to confirm")
    } finally {
      setConfirming(false)
    }
  }, [review, onResolved, load])

  if (review.length === 0 && alerts.length === 0) return null

  // Sheets, not markups: "3 measurements" means nothing to an estimator, but
  // "A-101, A-102" tells them exactly where to look.
  const sheetNumbers = Array.from(new Set(review.map((item) => item.sheet_number))).sort()

  return (
    <div className="border-b">
      {review.length > 0 && (
        <div className="space-y-2 border-l-2 border-l-warning px-3 py-2.5">
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
              </p>
            </div>
          </div>
          {canWrite && (
            <div className="flex gap-2 pl-5.5">
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
        <div key={alert.condition_id} className="border-l-2 border-l-warning px-3 py-2.5">
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
