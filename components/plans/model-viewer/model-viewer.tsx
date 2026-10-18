"use client";

/**
 * The 3D model, as a React component.
 *
 * Every place Arc shows a building — the drawings workspace, the plan
 * workbench, the community offering, the buyer portal — renders this one
 * component; they differ only in the controls they put around it. Three.js is
 * imported when the component mounts, so a page that never opens a model never
 * downloads it.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { Skeleton } from "@/components/ui/skeleton";
import type { SavedModelView } from "@/lib/drawings/architectural-model";
import type { FloorplanModel } from "@/lib/drawings/floorplan-model";
import { cn } from "@/lib/utils";

import type { TourSample } from "@/lib/plans/camera-tour";

import { loadModelRuntime } from "./model-runtime";
import {
  ModelScene,
  type ModelCameraPreset,
  type ModelLook,
  type ModelMeasurement,
  type ModelMode,
  type ModelPick,
  type ModelPin,
  type ModelQuality,
  type ModelSceneDiff,
  type ModelSceneTheme,
  type ModelTool,
  type ScreenPoint,
} from "./model-scene";
import { readModelTheme } from "./model-theme";

export type { ModelCameraPreset, ModelLook, ModelMeasurement, ModelMode, ModelPick, ModelPin, ModelSceneDiff, ModelTool, ScreenPoint };

/** Phones and small tablets get the plain forward render; everything else the full pipeline. */
function defaultQuality(): ModelQuality {
  if (typeof window === "undefined") return "high";
  return window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768 ? "fast" : "high";
}

export const modelXrSupported = () => ModelScene.xrSupported();

export interface ModelViewerHandle {
  preset: (name: ModelCameraPreset) => void;
  frame: (levelId: string, id: string) => void;
  project: (levelId: string, id: string) => ScreenPoint | null;
  captureView: (name: string) => SavedModelView | null;
  restoreView: (view: SavedModelView) => void;
  exportImage: (fileName: string) => void;
  exportGlb: (fileName: string) => Promise<void>;
  sectionThrough: (levelId: string, wallId: string) => void;
  flipSection: () => void;
  clearSection: () => void;
  clearMeasurements: () => void;
  startPhoto: () => void;
  stopPhoto: () => void;
  startRecording: () => void;
  stopRecording: () => TourSample[] | null;
  playTour: (samples: TourSample[]) => void;
  stopTour: () => void;
  enterXR: () => Promise<void>;
}

export interface ModelViewerProps {
  model: FloorplanModel;
  look?: ModelLook;
  /** A level id, or "all". */
  focus?: string;
  cutaway?: boolean;
  labels?: boolean;
  mode?: ModelMode;
  /** Surfaces lit from outside the viewer (ledger row, sheet hover). */
  highlight?: string[];
  selected?: string | null;
  /** Surface id → condition colour, for the Takeoff look. */
  takeoffColors?: Record<string, string>;
  /** Furniture being placed; the next floor click drops it. */
  placing?: { widthFt: number; depthFt: number; heightFt: number } | null;
  /** Local solar hour for the sun (the site's latitude and north come from the model). */
  sunHour?: number;
  tool?: ModelTool;
  sectionBox?: boolean;
  pins?: ModelPin[];
  diff?: ModelSceneDiff[];
  quality?: ModelQuality;
  onPinSelect?: (pinId: string, at: ScreenPoint) => void;
  onMeasure?: (measurements: ModelMeasurement[]) => void;
  /** Photo refinement 0..1, or null when photo mode ends. */
  onPhoto?: (progress: number | null) => void;
  onTourEnd?: () => void;
  onHover?: (pick: ModelPick | null, at: ScreenPoint | null) => void;
  onSelect?: (pick: ModelPick | null, at: ScreenPoint | null) => void;
  onPlace?: (point: { levelId: string; xFt: number; yFt: number }) => void;
  onObjectMove?: (change: { levelId: string; objectId: string; xFt: number; yFt: number }) => void;
  onModeChange?: (mode: ModelMode) => void;
  /** After each drawn frame — keeps cards anchored to a surface in place. */
  onFrame?: () => void;
  className?: string;
  label?: string;
}

const NO_HIGHLIGHT: string[] = [];
const NO_COLORS: Record<string, string> = {};
const NO_PINS: ModelPin[] = [];
const NO_DIFF: ModelSceneDiff[] = [];

export const ModelViewer = forwardRef<ModelViewerHandle, ModelViewerProps>(
  function ModelViewer(
    {
      model,
      look = "real",
      focus = "all",
      cutaway = true,
      labels = true,
      mode = "orbit",
      highlight = NO_HIGHLIGHT,
      selected = null,
      takeoffColors = NO_COLORS,
      placing = null,
      sunHour = 15,
      tool = "select",
      sectionBox = false,
      pins = NO_PINS,
      diff = NO_DIFF,
      quality,
      onPinSelect,
      onMeasure,
      onPhoto,
      onTourEnd,
      onHover,
      onSelect,
      onPlace,
      onObjectMove,
      onModeChange,
      onFrame,
      className,
      label = "3D model",
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [scene, setScene] = useState<ModelScene | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const handlers = useRef({ onHover, onSelect, onPlace, onObjectMove, onModeChange, onFrame, onPinSelect, onMeasure, onPhoto, onTourEnd });
    handlers.current = { onHover, onSelect, onPlace, onObjectMove, onModeChange, onFrame, onPinSelect, onMeasure, onPhoto, onTourEnd };
    const initialQuality = useRef(quality);
    const pointerInside = useRef(false);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      let created: ModelScene | null = null;
      let cancelled = false;
      loadModelRuntime()
        .then((runtime) => {
          if (cancelled) return;
          created = new ModelScene(
            runtime,
            container,
            {
              onHover: (pick, at) => handlers.current.onHover?.(pick, at),
              onSelect: (pick, at) => handlers.current.onSelect?.(pick, at),
              onPlace: (point) => handlers.current.onPlace?.(point),
              onObjectMove: (change) => handlers.current.onObjectMove?.(change),
              onModeChange: (next) => handlers.current.onModeChange?.(next),
              onPinSelect: (pinId, at) => handlers.current.onPinSelect?.(pinId, at),
              onMeasure: (measurements) => handlers.current.onMeasure?.(measurements),
              onPhoto: (progress) => handlers.current.onPhoto?.(progress),
              onTourEnd: () => handlers.current.onTourEnd?.(),
              onFrame: () => handlers.current.onFrame?.(),
            },
            readModelTheme(),
            initialQuality.current ?? defaultQuality(),
          );
          setScene(created);
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setFailure(
              error instanceof Error && /webgl/i.test(error.message)
                ? "This browser can't show 3D. Turn on hardware acceleration and reload."
                : "The 3D viewer didn't load. Reload the page to try again.",
            );
        });
      return () => {
        cancelled = true;
        created?.dispose();
        setScene(null);
      };
    }, []);

    // Theme follows the app: the html element's class flips for dark mode.
    useEffect(() => {
      if (!scene) return;
      const observer = new MutationObserver(() => scene.setTheme(readModelTheme() satisfies ModelSceneTheme));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
      return () => observer.disconnect();
    }, [scene]);

    useEffect(() => {
      scene?.setModel(model);
    }, [scene, model]);
    useEffect(() => {
      scene?.setLook(look);
    }, [scene, look]);
    useEffect(() => {
      scene?.setTakeoffColors(takeoffColors);
    }, [scene, takeoffColors]);
    useEffect(() => {
      scene?.setFocus(focus);
    }, [scene, focus]);
    useEffect(() => {
      scene?.setCutaway(cutaway);
    }, [scene, cutaway]);
    useEffect(() => {
      scene?.setLabels(labels);
    }, [scene, labels]);
    useEffect(() => {
      scene?.setMode(mode);
    }, [scene, mode]);
    useEffect(() => {
      scene?.setHighlight(highlight);
    }, [scene, highlight]);
    useEffect(() => {
      scene?.setSelected(selected);
    }, [scene, selected]);
    useEffect(() => {
      scene?.setPlacing(placing);
    }, [scene, placing]);
    useEffect(() => {
      scene?.setSun(sunHour);
    }, [scene, sunHour]);
    useEffect(() => {
      scene?.setTool(tool);
    }, [scene, tool]);
    useEffect(() => {
      scene?.setSectionBox(sectionBox);
    }, [scene, sectionBox]);
    useEffect(() => {
      scene?.setPins(pins);
    }, [scene, pins]);
    useEffect(() => {
      scene?.setDiff(diff);
    }, [scene, diff]);
    useEffect(() => {
      if (quality) scene?.setQuality(quality);
    }, [scene, quality]);

    // Walk keys only while the model is the thing being looked at.
    useEffect(() => {
      if (!scene) return;
      const relevant = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return false;
        return pointerInside.current || containerRef.current?.contains(document.activeElement) === true;
      };
      const down = (event: KeyboardEvent) => {
        if (relevant(event) && scene.handleKey(event, true)) event.preventDefault();
      };
      const up = (event: KeyboardEvent) => {
        scene.handleKey(event, false);
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      return () => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
      };
    }, [scene]);

    useImperativeHandle(
      ref,
      () => ({
        preset: (name) => scene?.preset(name),
        frame: (levelId, id) => scene?.frameSurface(levelId, id),
        project: (levelId, id) => scene?.projectSurface(levelId, id) ?? null,
        captureView: (name) => scene?.captureView(name) ?? null,
        restoreView: (view) => scene?.restoreView(view),
        exportImage: (fileName) => scene?.exportImage(fileName),
        exportGlb: async (fileName) => {
          await scene?.exportGlb(fileName);
        },
        sectionThrough: (levelId, wallId) => scene?.sectionThrough(levelId, wallId),
        flipSection: () => scene?.flipSection(),
        clearSection: () => scene?.clearSection(),
        clearMeasurements: () => scene?.clearMeasurements(),
        startPhoto: () => void scene?.startPhoto(),
        stopPhoto: () => scene?.stopPhoto(),
        startRecording: () => scene?.startRecording(),
        stopRecording: () => scene?.stopRecording() ?? null,
        playTour: (samples) => scene?.playTour(samples),
        stopTour: () => scene?.stopTour(),
        enterXR: async () => {
          await scene?.enterXR();
        },
      }),
      [scene],
    );

    return (
      <div
        ref={containerRef}
        role="application"
        aria-label={label}
        className={cn("relative h-full w-full overflow-hidden", className)}
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
        }}
      >
        {!scene && !failure && (
          <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Loading 3D model">
            <Skeleton className="absolute inset-0 rounded-none opacity-60" />
            <span className="relative text-xs text-muted-foreground">Loading 3D…</span>
          </div>
        )}
        {failure && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground" role="alert">
            {failure}
          </div>
        )}
      </div>
    );
  },
);
