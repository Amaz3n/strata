"use client"

/**
 * "View in 3D" wherever a plan is being sold.
 *
 * The model document is fetched only when the dialog opens, and Three.js only
 * after that — a price sheet with twelve plans on it pays nothing for having
 * the button on every row.
 */

import dynamic from "next/dynamic"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { loadPublishedFloorplanModelAction } from "@/app/(app)/floorplan/actions"
import { Box, Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { unwrapAction } from "@/lib/action-result"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"

const Plan3dViewer = dynamic(
  () => import("@/components/plans/plan-3d-viewer").then((module) => module.Plan3dViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the viewer…
      </div>
    ),
  },
)

export function Plan3dDialog({
  planId,
  planLabel,
  className,
}: {
  planId: string
  planLabel: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState<FloorplanModel | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (model || loading) return
    setLoading(true)
    try {
      const loaded = unwrapAction(await loadPublishedFloorplanModelAction(planId))
      if (!loaded) {
        toast.error("This plan's 3D model is no longer published")
        setOpen(false)
        return
      }
      setModel(loaded)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the 3D model")
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }, [loading, model, planId])

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={className}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
          void load()
        }}
        aria-label={`View ${planLabel} in 3D`}
      >
        <Box className="h-3.5 w-3.5" />
        3D
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[80vh] max-w-5xl gap-0 p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="text-sm font-medium">{planLabel}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            {model ? (
              <Plan3dViewer model={model} caption={planLabel} />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading the model…
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
