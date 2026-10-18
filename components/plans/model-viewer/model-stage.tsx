"use client";

/**
 * A model with its own controls — for surfaces that only look at a building:
 * the plan workbench walkthrough, the offering dialog, the buyer portal. The
 * drawings workspace drives `ModelViewer` directly because its controls are
 * tied to the sheet beside it.
 */

import { useMemo, useRef, useState } from "react";
import { Download, MoreHorizontal, Play, Scan } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SavedModelView } from "@/lib/drawings/architectural-model";
import type { FloorplanModel } from "@/lib/drawings/floorplan-model";
import { cn } from "@/lib/utils";

import { ALL_LEVELS, ModelControls, ModelHint } from "./model-controls";
import { ModelTools, useModelStudio } from "./model-tools";
import {
  ModelViewer,
  type ModelLook,
  type ModelMode,
  type ModelPick,
  type ModelViewerHandle,
} from "./model-viewer";

export interface ModelStageProps {
  model: FloorplanModel;
  /** Shown in exports and the accessible name. */
  title: string;
  looks?: ModelLook[];
  selected?: string | null;
  onSelect?: (pick: ModelPick | null) => void;
  /** Offered only where views are saved onto the model. */
  onSaveView?: (view: SavedModelView) => void;
  /** Hide exports and the hint line — the buyer portal. */
  compact?: boolean;
  className?: string;
}

export function ModelStage({
  model,
  title,
  looks = ["real", "xray"],
  selected = null,
  onSelect,
  onSaveView,
  compact = false,
  className,
}: ModelStageProps) {
  const viewer = useRef<ModelViewerHandle>(null);
  const studio = useModelStudio();
  const [focus, setFocus] = useState(ALL_LEVELS);
  const [cutaway, setCutaway] = useState(model.levels.length > 0);
  const [look, setLook] = useState<ModelLook>("real");
  const [mode, setMode] = useState<ModelMode>("orbit");
  const levels = useMemo(
    () => [...model.levels].sort((a, b) => a.order - b.order).map((level) => ({ id: level.id, name: level.name })),
    [model.levels],
  );
  const fileName = title.replace(/[^\w-]+/g, "-").toLowerCase() || "model";

  return (
    <div className={cn("relative h-full min-h-[320px] w-full bg-muted/40", className)}>
      <ModelViewer
        ref={viewer}
        model={model}
        look={look}
        focus={focus}
        cutaway={cutaway}
        mode={mode}
        selected={selected}
        onSelect={(pick) => onSelect?.(pick)}
        onModeChange={setMode}
        {...studio.viewerProps}
        label={`${title} in 3D`}
      />
      <ModelTools
        studio={studio}
        viewerRef={viewer}
        fileName={fileName}
        site={model.site}
        offer={{ measure: !compact, section: !compact, photo: true, record: !compact }}
        onSaveTour={
          onSaveView
            ? (path) => {
                const view = viewer.current?.captureView(`Walkthrough ${(model.views ?? []).filter((candidate) => candidate.path).length + 1}`);
                if (view) onSaveView({ ...view, position: [path[0][0], path[0][1], path[0][2]], target: [path[0][3], path[0][4], path[0][5]], path });
              }
            : undefined
        }
        className={compact ? "bottom-3" : undefined}
      />
      <ModelControls
        levels={levels}
        focus={focus}
        onFocus={setFocus}
        cutaway={cutaway}
        onCutaway={setCutaway}
        look={look}
        onLook={setLook}
        looks={looks}
        mode={mode}
        onMode={setMode}
        onPreset={(preset) => viewer.current?.preset(preset)}
        trailing={
          compact && (model.views ?? []).length === 0 ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" className="bg-card" aria-label="Model options">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {onSaveView && (
                  <DropdownMenuItem
                    onSelect={() => {
                      const view = viewer.current?.captureView(`View ${(model.views?.length ?? 0) + 1}`);
                      if (view) onSaveView(view);
                    }}
                  >
                    Save this view
                  </DropdownMenuItem>
                )}
                {(model.views ?? []).map((view) => (
                  <DropdownMenuItem
                    key={view.id}
                    onSelect={() => {
                      if (view.path && view.path.length > 1) {
                        viewer.current?.playTour(view.path);
                        studio.setTouring(true);
                      } else viewer.current?.restoreView(view);
                    }}
                  >
                    {view.path ? <Play className="size-3.5" /> : <Scan className="size-3.5" />}
                    {view.path ? `Play ${view.name}` : `Go to ${view.name}`}
                  </DropdownMenuItem>
                ))}
                {!compact && (
                  <>
                    <DropdownMenuItem onSelect={() => viewer.current?.exportImage(fileName)}>
                      <Download className="size-3.5" />
                      Download image
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void viewer.current?.exportGlb(fileName)}>
                      <Download className="size-3.5" />
                      Download 3D file (GLB)
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {!compact && <ModelHint mode={mode} />}
    </div>
  );
}
