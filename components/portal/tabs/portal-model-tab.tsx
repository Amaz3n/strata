"use client"

/**
 * The buyer-facing walkthrough.
 *
 * A thin client boundary so the portal page stays a server component. Three.js
 * is imported when the viewer mounts, so it never enters the portal's shared
 * chunks for buyers who never open this tab.
 */

import { ModelStage } from "@/components/plans/model-viewer/model-stage"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"

export function Plan3dViewerPanel({ model, planLabel }: { model: FloorplanModel; planLabel: string }) {
  return (
    <div className="border border-border">
      <div className="h-[70vh] min-h-[420px]">
        <ModelStage model={model} title={planLabel} compact />
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        A model of your floorplan, built from the construction drawings. Room sizes and layout follow the plans;
        finishes, fixtures and colours are not shown.
      </p>
    </div>
  )
}
