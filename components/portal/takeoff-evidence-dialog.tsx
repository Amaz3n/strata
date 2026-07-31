"use client"

/**
 * "Show me on the plans" — the client-facing half of the transparent estimate.
 *
 * Renders the sheets a line's quantity was measured from, with only that
 * condition's geometry drawn over them. Deliberately read-only and
 * deliberately minimal: no pan/zoom chrome, no other trades' markups, no
 * pricing. The claim being verified is "this number came from these regions",
 * and anything else on screen weakens it.
 */

import { useCallback, useEffect, useState } from "react"
import { Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { TakeoffEvidence } from "@/lib/services/estimate-portal"
import { loadTakeoffEvidenceAction } from "@/app/e/[token]/actions"

export interface TakeoffEvidenceDialogProps {
  token: string
  conditionId: string | null
  onClose: () => void
}

export function TakeoffEvidenceDialog({ token, conditionId, onClose }: TakeoffEvidenceDialogProps) {
  const [evidence, setEvidence] = useState<TakeoffEvidence | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!conditionId) {
      setEvidence(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    loadTakeoffEvidenceAction({ token, condition_id: conditionId })
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setError("These measurements aren't shared on this estimate.")
          return
        }
        setEvidence(result)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the plans right now.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, conditionId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose()
    },
    [onClose],
  )

  return (
    <Dialog open={!!conditionId} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              {evidence?.condition_name ?? "Measured on the plans"}
            </DialogTitle>
            {evidence && (
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {evidence.total_quantity.toLocaleString("en-US", { maximumFractionDigits: 1 })}{" "}
                {evidence.uom.toUpperCase()} across {evidence.sheets.length} sheet
                {evidence.sheets.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="max-h-[calc(92vh-4rem)] overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the plans…
            </div>
          ) : error ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{error}</p>
          ) : evidence ? (
            <div className="space-y-6">
              {evidence.sheets.map((sheet) => (
                <figure key={sheet.drawing_sheet_id} className="space-y-2">
                  <figcaption className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium">
                      {sheet.sheet_number}
                      {sheet.sheet_title ? ` · ${sheet.sheet_title}` : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {sheet.shapes.length} region{sheet.shapes.length === 1 ? "" : "s"}
                    </span>
                  </figcaption>
                  <SheetPlate sheet={sheet} color={evidence.color} />
                </figure>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One sheet image with the condition's geometry laid over it. The overlay is a
 * viewBox-normalized SVG so it scales with the image at any width without any
 * measurement of the rendered element.
 */
function SheetPlate({
  sheet,
  color,
}: {
  sheet: TakeoffEvidence["sheets"][number]
  color: string
}) {
  if (!sheet.image_url) {
    return (
      <div className="border border-dashed p-6 text-center text-xs text-muted-foreground">
        This sheet isn&apos;t available to view.
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden border bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not a static asset */}
      <img src={sheet.image_url} alt={`${sheet.sheet_number} plan sheet`} className="block w-full" />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        aria-hidden
      >
        {sheet.shapes.map((shape) => (
          <EvidenceShape key={shape.id} shape={shape} color={color} />
        ))}
      </svg>
    </div>
  )
}

function EvidenceShape({
  shape,
  color,
}: {
  shape: TakeoffEvidence["sheets"][number]["shapes"][number]
  color: string
}) {
  // The normalized points map straight onto the 0..1000 viewBox.
  const points = shape.points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }))
  if (points.length === 0) return null

  if (shape.type === "count") {
    return (
      <g>
        {points.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r={6} fill={color} opacity={0.85} />
        ))}
      </g>
    )
  }

  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")

  if (shape.type === "area") {
    return (
      <g>
        <path d={`${path} Z`} fill={color} opacity={0.22} />
        <path d={`${path} Z`} fill="none" stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" />
      </g>
    )
  }

  return (
    <path
      d={path}
      fill="none"
      stroke={color}
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  )
}
