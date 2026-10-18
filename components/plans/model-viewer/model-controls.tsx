"use client";

/**
 * The controls that float over a model: which floor, cut open or whole, how
 * it is drawn, where the camera stands. Shared by every surface that shows a
 * model so a buyer and an estimator learn the same handful of buttons.
 */

import type { ReactNode } from "react";
import { Footprints, Scissors } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import type { ModelCameraPreset, ModelLook, ModelMode } from "./model-viewer";

export const ALL_LEVELS = "all";

export interface ModelControlsProps {
  levels: Array<{ id: string; name: string }>;
  focus: string;
  onFocus: (levelId: string) => void;
  cutaway: boolean;
  onCutaway: (on: boolean) => void;
  look: ModelLook;
  onLook: (look: ModelLook) => void;
  /** Takeoff look only where someone measures — never on a buyer's screen. */
  looks?: ModelLook[];
  mode: ModelMode;
  onMode: (mode: ModelMode) => void;
  onPreset: (preset: ModelCameraPreset) => void;
  /** Left-hand lead, e.g. the model status chip. */
  leading?: ReactNode;
  /** Right-hand trailing, e.g. an export menu. */
  trailing?: ReactNode;
  className?: string;
}

const LOOK_LABELS: Record<ModelLook, string> = {
  real: "Real",
  takeoff: "Takeoff",
  xray: "X-ray",
};

const segment =
  "h-8 rounded-none border-border bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-none data-[state=on]:bg-foreground data-[state=on]:text-background";

export function ModelControls({
  levels,
  focus,
  onFocus,
  cutaway,
  onCutaway,
  look,
  onLook,
  looks = ["real", "takeoff", "xray"],
  mode,
  onMode,
  onPreset,
  leading,
  trailing,
  className,
}: ModelControlsProps) {
  const walking = mode === "walk";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2",
        className,
      )}
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
        {leading}
        {levels.length > 1 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={focus}
            onValueChange={(value) => value && onFocus(value)}
            aria-label="Floor"
          >
            <ToggleGroupItem value={ALL_LEVELS} className={segment} disabled={walking}>
              All
            </ToggleGroupItem>
            {levels.map((level) => (
              <ToggleGroupItem key={level.id} value={level.id} className={segment}>
                {level.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5 bg-card text-xs", cutaway && "border-foreground")}
          aria-pressed={cutaway}
          disabled={walking}
          onClick={() => onCutaway(!cutaway)}
        >
          <Scissors className="size-3.5" />
          Cutaway
        </Button>
      </div>
      <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1.5">
        {looks.length > 1 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={look}
            onValueChange={(value) => value && onLook(value as ModelLook)}
            aria-label="Look"
          >
            {looks.map((option) => (
              <ToggleGroupItem key={option} value={option} className={segment}>
                {LOOK_LABELS[option]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <div className="flex max-sm:hidden" role="group" aria-label="Camera">
          {(["iso", "top", "front"] as const).map((preset, index) => (
            <Button
              key={preset}
              variant="outline"
              size="sm"
              className={cn("h-8 bg-card px-2.5 text-xs capitalize", index > 0 && "border-l-0")}
              onClick={() => onPreset(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
        <Button
          variant={walking ? "default" : "outline"}
          size="sm"
          className={cn("h-8 gap-1.5 text-xs", !walking && "bg-card")}
          aria-pressed={walking}
          onClick={() => onMode(walking ? "orbit" : "walk")}
        >
          <Footprints className="size-3.5" />
          {walking ? "Exit walk" : "Walk"}
        </Button>
        {trailing}
      </div>
    </div>
  );
}

/** The one line of help under a model, phrased for what you can do right now. */
export function ModelHint({ mode, placing, className }: { mode: ModelMode; placing?: boolean; className?: string }) {
  const text = placing
    ? "Click the floor to place it · R rotates · Esc cancels"
    : mode === "walk"
      ? "W A S D to move · Shift to hurry · drag to look · click the floor to go there · Esc to fly out"
      : "Drag to orbit · right-drag or Shift-drag to pan · scroll zooms toward the cursor · double-click to fly in";
  return (
    <p
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-10 truncate border-t bg-background/85 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm",
        className,
      )}
    >
      {text}
    </p>
  );
}
