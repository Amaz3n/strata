"use client"

/**
 * The buyer-facing walkthrough.
 *
 * A thin client boundary whose only job is to hold the dynamic import — the
 * portal page itself stays a server component, and Three.js never enters the
 * portal's shared chunks for the buyers who never open this tab.
 */

import dynamic from "next/dynamic"

import { Loader2 } from "@/components/icons"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"

const Plan3dViewer = dynamic(
  () => import("@/components/plans/plan-3d-viewer").then((module) => module.Plan3dViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your home…
      </div>
    ),
  },
)

export function Plan3dViewerPanel({ model, planLabel }: { model: FloorplanModel; planLabel: string }) {
  return (
    <div className="border border-border">
      <div className="h-[70vh] min-h-[420px]">
        <Plan3dViewer model={model} caption={planLabel} compact />
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        A model of your floorplan, built from the construction drawings. Room sizes and layout follow the plans;
        finishes, fixtures and colours are not shown.
      </p>
    </div>
  )
}
