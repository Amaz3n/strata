"use client";

/**
 * The building, beside its sheets.
 *
 * Every state a model can be in gets a real screen: nothing traced yet (with
 * one button to trace it), a trace running (with the step it is on), a trace
 * that failed (with why, and the way back), a model older than its drawings,
 * and the model itself. The sheet stays usable throughout — tracing takes
 * about a minute and nobody should wait on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Box, Check, Copy, GitCompare, Link2, Loader2, Magnet, Play, RefreshCw, RotateCw, Scan, Scissors, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ModelPreparation } from "@/components/plans/model-preparation";
import { ModelControls, ModelHint } from "@/components/plans/model-viewer/model-controls";
import { ModelTools, sectionThroughWall, useModelStudio } from "@/components/plans/model-viewer/model-tools";
import {
  ModelViewer,
  type ModelLook,
  type ModelMode,
  type ModelPick,
  type ModelViewerHandle,
  type ScreenPoint,
} from "@/components/plans/model-viewer/model-viewer";
import { FINISH_PRESETS, type BuildingObject, type SavedModelView, type SiteOrientation, type SurfaceFinish } from "@/lib/drawings/architectural-model";
import type { FloorplanModel } from "@/lib/drawings/floorplan-model";
import { clearanceIssues, placeInRoom, roomContaining, snapToWall } from "@/lib/drawings/furniture-layout";
import { furnitureModel } from "@/lib/drawings/furniture-catalog";
import type { SurfaceTakeoffMap } from "@/lib/drawings/model-takeoff";
import { formatQuantity } from "@/lib/drawings/measure";
import type { FloorplanTarget } from "@/lib/services/floorplan-models";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { cn } from "@/lib/utils";

import type { PlacingPiece } from "./design-panel";
import { ModelScanBays, ScanReveal, type ScanBay } from "./scan-overlay";
import type { ModelExtras } from "./use-model-extras";
import { GENERATION_STAGES, type useWorkspaceModel } from "./use-workspace-model";

type ModelState = ReturnType<typeof useWorkspaceModel>;

export const FLOOR_FINISHES: Array<{ key: string; label: string }> = [
  { key: "oak", label: "White oak" },
  { key: "walnut", label: "Walnut" },
  { key: "porcelain", label: "Tile" },
  { key: "carpet", label: "Carpet" },
  { key: "limestone", label: "Stone" },
  { key: "concrete", label: "Concrete" },
];

export interface ModelPaneProps {
  state: ModelState;
  target: FloorplanTarget | null;
  /** Why this workspace can't own a model (a production lot), and where it lives. */
  unavailable?: { message: string; href?: string; linkLabel?: string } | null;
  canWrite: boolean;
  viewerRef: RefObject<ModelViewerHandle | null>;
  focus: string;
  onFocus: (levelId: string) => void;
  cutaway: boolean;
  onCutaway: (on: boolean) => void;
  look: ModelLook;
  onLook: (look: ModelLook) => void;
  mode: ModelMode;
  onMode: (mode: ModelMode) => void;
  highlight: string[];
  takeoffColors: Record<string, string>;
  takeoff: Record<string, SurfaceTakeoffMap>;
  rollups: ConditionRollup[] | null;
  selected: ModelPick | null;
  onSelect: (pick: ModelPick | null) => void;
  onHover: (pick: ModelPick | null) => void;
  placing: PlacingPiece | null;
  extras: ModelExtras;
  onPinSelect: (pinId: string) => void;
  onSite: (site: SiteOrientation) => void;
  onSaveView: (levelId: string, view: SavedModelView) => void;
  /** A saved view or walkthrough to open once the model is ready (a shared link). */
  initialViewId: string | null;
  /** The sheets being traced, shown in the scan while the model builds. */
  scanBays: ScanBay[];
  onPlace: (point: { levelId: string; xFt: number; yFt: number }) => void;
  onCancelPlacing: () => void;
  onObjectMove: (change: { levelId: string; objectId: string; xFt: number; yFt: number }) => void;
  onRoomFinish: (levelId: string, roomId: string, finish: SurfaceFinish) => void;
  onAssignRoom: (levelId: string, roomId: string, conditionId: string) => void;
  onAddWall: (levelId: string, wallId: string) => void;
  onShowOnSheet: (pick: ModelPick) => void;
  onObjectEdit: (levelId: string, object: BuildingObject | null, removeId?: string) => void;
}

export function ModelPane(props: ModelPaneProps) {
  const { state, target, unavailable, canWrite } = props;
  const [preparing, setPreparing] = useState(false);
  // A model that has just been built arrives with one pass of the scan beam.
  const previousPhase = useRef(state.phase);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (previousPhase.current === "generating" && state.phase === "ready") setRevealing(true);
    previousPhase.current = state.phase;
  }, [state.phase]);
  const endReveal = useCallback(() => setRevealing(false), []);

  if (unavailable) {
    return (
      <PaneMessage icon={<Box className="size-5" />} title="The 3D model lives on the plan">
        <p>{unavailable.message}</p>
        {unavailable.href && (
          <Button asChild size="sm" variant="outline" className="mt-1 gap-1">
            <Link href={unavailable.href}>
              {unavailable.linkLabel ?? "Open the plan"}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        )}
      </PaneMessage>
    );
  }
  if (!target) return null;

  const prepare = (
    <ModelPreparation
      target={target}
      open={preparing}
      onClose={() => setPreparing(false)}
      busy={state.starting}
      onGenerate={(sources) => {
        void state.generate({ force: (state.record?.correction_count ?? 0) > 0, sources }).then((started) => started && setPreparing(false));
      }}
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="relative h-full" role="status" aria-label="Loading 3D model">
        <Skeleton className="absolute inset-0 rounded-none opacity-50" />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <PaneMessage icon={<AlertTriangle className="size-5 text-destructive" />} title="The 3D model didn't load">
        <p>{state.error}</p>
        <Button size="sm" variant="outline" className="mt-1" onClick={() => void state.reload()}>
          Try again
        </Button>
      </PaneMessage>
    );
  }
  if (state.phase === "none" || state.phase === "failed") {
    const failed = state.phase === "failed";
    return (
      <PaneMessage
        icon={failed ? <AlertTriangle className="size-5 text-warning" /> : <Box className="size-5" />}
        title={failed ? "The model couldn't be built" : "No 3D model yet"}
      >
        <p>
          {failed
            ? (state.record?.error ?? "Arc couldn't read walls and rooms from these sheets.")
            : "Arc builds it from your floor plans: walls, doors, windows and rooms, floor by floor, at the sheet's scale."}
        </p>
        {canWrite ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button size="sm" className="gap-1.5" disabled={state.starting} onClick={() => void state.generate({ force: false })}>
              {state.starting ? <Loader2 className="size-3.5 animate-spin" /> : failed ? <RefreshCw className="size-3.5" /> : <Box className="size-3.5" />}
              {failed ? "Try again" : "Build the 3D model"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreparing(true)}>
              Choose sheets and floors
            </Button>
          </div>
        ) : (
          <p className="text-xs">Ask someone who can edit plans to build it.</p>
        )}
        <p className="text-xs">Usually under a minute. You can keep measuring while it works.</p>
        {prepare}
      </PaneMessage>
    );
  }
  if (state.phase === "generating") {
    return <GeneratingState stage={state.record?.generation_stage ?? "queued"} startedAt={state.record?.updated_at ?? null} hasPrevious={!!state.model} bays={props.scanBays} />;
  }
  return (
    <>
      <ReadyModel {...props} model={state.model as FloorplanModel} onPrepare={() => setPreparing(true)} revealing={revealing} onRevealDone={endReveal} />
      {prepare}
    </>
  );
}

function PaneMessage({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6">
      <div className="flex max-w-sm flex-col items-start gap-2 text-sm text-muted-foreground">
        <span className="grid size-10 place-items-center border bg-card text-foreground">{icon}</span>
        <p className="text-base font-semibold text-foreground">{title}</p>
        {children}
      </div>
    </div>
  );
}

function GeneratingState({ stage, startedAt, hasPrevious, bays }: { stage: string; startedAt: string | null; hasPrevious: boolean; bays: ScanBay[] }) {
  const index = Math.max(0, GENERATION_STAGES.findIndex((step) => step.key === stage));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : 0;
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6" role="status" aria-live="polite" aria-label="Building the 3D model">
      <div className="w-full max-w-md space-y-4">
        <ModelScanBays bays={bays} step={GENERATION_STAGES[index]?.label ?? "Working"} />
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-base font-semibold">Building the 3D model</p>
            <p className="text-sm text-muted-foreground">
              {hasPrevious ? "The current model stays until the new one is ready." : "Keep working on the sheet — it appears here when it's done."}
            </p>
          </div>
          <p className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </p>
        </div>
        <ol className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {GENERATION_STAGES.map((step, position) => {
            const done = position < index;
            const current = position === index;
            return (
              <li key={step.key} className={cn("flex items-center gap-2 text-sm", !done && !current && "text-muted-foreground")}>
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center border",
                    done && "border-success bg-success text-success-foreground",
                    current && "border-primary",
                  )}
                >
                  {done ? <Check className="size-2.5" /> : current ? <Loader2 className="size-2.5 animate-spin text-primary" /> : null}
                </span>
                {step.label}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function ReadyModel({
  state,
  model,
  canWrite,
  viewerRef,
  focus,
  onFocus,
  cutaway,
  onCutaway,
  look,
  onLook,
  mode,
  onMode,
  highlight,
  takeoffColors,
  takeoff,
  rollups,
  selected,
  onSelect,
  onHover,
  placing,
  onPlace,
  onCancelPlacing,
  onObjectMove,
  onRoomFinish,
  onAssignRoom,
  onAddWall,
  onShowOnSheet,
  onObjectEdit,
  extras,
  onPinSelect,
  onSite,
  onSaveView,
  initialViewId,
  onPrepare,
  revealing,
  onRevealDone,
}: ModelPaneProps & { model: FloorplanModel; onPrepare: () => void; revealing: boolean; onRevealDone: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ pick: ModelPick; at: ScreenPoint } | null>(null);
  const studio = useModelStudio();
  const levels = [...model.levels].sort((a, b) => a.order - b.order).map((level) => ({ id: level.id, name: level.name }));
  const placingSize = useMemo(
    () => (placing ? { widthFt: placing.widthFt, depthFt: placing.depthFt, heightFt: placing.heightFt } : null),
    [placing],
  );
  const record = state.record;
  const fileName = (record?.id ?? "model").slice(0, 8);
  const views = model.views ?? [];
  const comparison = extras.comparison;

  const openView = (view: SavedModelView) => {
    if (view.path && view.path.length > 1) {
      viewerRef.current?.playTour(view.path);
      studio.setTouring(true);
    } else viewerRef.current?.restoreView(view);
  };
  const copyLink = (view: SavedModelView) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "3d");
    url.searchParams.set("modelView", view.id);
    void navigator.clipboard.writeText(url.toString()).then(() => toast.success("Link copied"));
  };
  // A shared link opens its view (or plays its walkthrough) once, when the model is first on screen.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialViewId) return;
    const view = views.find((candidate) => candidate.id === initialViewId);
    if (!view) return;
    opened.current = true;
    const frame = requestAnimationFrame(() => openView(view));
    return () => cancelAnimationFrame(frame);
  });

  // Keep the selection card pinned to its surface as the camera moves.
  const reposition = () => {
    const card = cardRef.current;
    if (!card || !selected) return;
    const point = viewerRef.current?.project(selected.levelId, selected.id);
    if (!point) {
      card.style.visibility = "hidden";
      return;
    }
    const parent = card.parentElement?.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let x = point.x + 18;
    if (parent && x + width > parent.width - 10) x = point.x - width - 18;
    const y = parent ? Math.max(56, Math.min(point.y - 24, parent.height - height - 40)) : point.y;
    card.style.visibility = "visible";
    card.style.transform = `translate(${Math.max(10, x)}px, ${y}px)`;
  };

  useEffect(reposition);

  return (
    <div className="relative h-full overflow-hidden bg-muted/40">
      <ModelViewer
        ref={viewerRef}
        model={extras.displayModel ?? model}
        look={look}
        focus={focus}
        cutaway={cutaway}
        mode={mode}
        {...studio.viewerProps}
        pins={extras.modelPins}
        diff={comparison?.scene}
        onPinSelect={(pinId) => onPinSelect(pinId)}
        highlight={highlight}
        selected={selected?.id ?? null}
        takeoffColors={takeoffColors}
        placing={placingSize}
        onHover={(pick, at) => {
          onHover(pick);
          setTip(pick && at ? { pick, at } : null);
        }}
        onSelect={(pick) => onSelect(pick)}
        onPlace={onPlace}
        onObjectMove={onObjectMove}
        onModeChange={onMode}
        onFrame={reposition}
        label="3D model of this building"
      />
      <ModelControls
        levels={levels}
        focus={focus}
        onFocus={onFocus}
        cutaway={cutaway}
        onCutaway={onCutaway}
        look={look}
        onLook={onLook}
        mode={mode}
        onMode={onMode}
        onPreset={(preset) => viewerRef.current?.preset(preset)}
        trailing={<CompareMenu extras={extras} />}
        leading={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-8 items-center gap-2 border bg-card px-2.5 text-xs font-medium hover:border-line-strong">
                <span className={cn("size-1.5 rounded-full", record?.stale ? "bg-warning" : record?.status === "published" ? "bg-success" : "bg-primary")} aria-hidden />
                Model
                <span className="text-muted-foreground max-[480px]:hidden">{record?.status === "published" ? "· shared" : "· draft"}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel className="microlabel">3D model</DropdownMenuLabel>
              <div className="space-y-1.5 px-2 pb-2 text-xs">
                {model.levels.map((level) => (
                  <div key={level.id} className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{level.name}</span>
                    <span className="font-mono text-muted-foreground">
                      {level.source.sheetNumber ?? "—"} · {level.rooms.length} rooms · {level.walls.length} walls
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-muted-foreground">
                  {record?.correction_count ? `${record.correction_count} ${record.correction_count === 1 ? "correction" : "corrections"} · ` : ""}
                  {record?.status === "published" ? "Shared on the client portal" : "Not shared with the client yet"}
                </p>
                {record?.stale && <p className="text-warning">The drawings changed since this model was built.</p>}
              </div>
              {canWrite && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={state.starting} onSelect={() => void state.generate({ force: true })}>
                    <RefreshCw className="size-3.5" />
                    Rebuild from the sheets
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onPrepare}>Choose sheets and floors…</DropdownMenuItem>
                  {record?.status !== "published" && (
                    <DropdownMenuItem onSelect={() => void state.publish()}>Share on the client portal</DropdownMenuItem>
                  )}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="microlabel">Views & walkthroughs</DropdownMenuLabel>
              {views.length === 0 && <p className="px-2 pb-1.5 text-xs text-muted-foreground">Record a walkthrough with the ● tool, or save the camera.</p>}
              {views.map((view) => (
                <DropdownMenuItem key={view.id} onSelect={() => openView(view)} className="gap-2">
                  {view.path ? <Play className="size-3.5" /> : <Scan className="size-3.5" />}
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  <button
                    type="button"
                    className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
                    aria-label={`Copy a link to ${view.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      copyLink(view);
                    }}
                  >
                    <Link2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
              {canWrite && (
                <DropdownMenuItem
                  onSelect={() => {
                    const view = viewerRef.current?.captureView(`View ${views.length + 1}`);
                    if (view) onSaveView(view.levelId === "all" ? (model.levels[0]?.id ?? view.levelId) : view.levelId, view);
                  }}
                >
                  Save this view
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => viewerRef.current?.exportImage(`model-${fileName}`)}>Download image</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void viewerRef.current?.exportGlb(`model-${fileName}`)}>Download 3D file (GLB)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {record?.stale && canWrite && (
        <div className="absolute inset-x-3 top-14 z-10 flex justify-center">
          <div className="flex items-center gap-2 border border-warning/60 bg-popover px-3 py-1.5 text-xs shadow-lg">
            <AlertTriangle className="size-3.5 text-warning" />
            The drawings changed since this model was built.
            <Button size="sm" variant="outline" className="h-6 text-xs" disabled={state.starting} onClick={() => void state.generate({ force: true })}>
              Rebuild
            </Button>
          </div>
        </div>
      )}
      {placing && (
        <div className="absolute inset-x-3 bottom-10 z-10 flex justify-center">
          <div className="flex items-center gap-2 border bg-popover py-1 pl-3 pr-1 text-sm shadow-lg">
            <span className="font-medium">Placing {placing.name.toLowerCase()}</span>
            <span className="text-xs text-muted-foreground">{placing.againstWall ? "Click near a wall — it backs onto it" : "Click the floor"}</span>
            <Button size="sm" variant="ghost" className="h-7" onClick={onCancelPlacing}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {revealing && <ScanReveal onDone={onRevealDone} />}
      <ModelTools
        studio={studio}
        viewerRef={viewerRef}
        fileName={`model-${fileName}`}
        site={model.site}
        onSite={canWrite ? onSite : undefined}
        onSaveTour={
          canWrite
            ? (path) => {
                const view = viewerRef.current?.captureView(`Walkthrough ${views.filter((candidate) => candidate.path).length + 1}`);
                if (!view) return;
                const levelId = view.levelId === "all" ? (model.levels[0]?.id ?? view.levelId) : view.levelId;
                onSaveView(levelId, { ...view, position: [path[0][0], path[0][1], path[0][2]], target: [path[0][3], path[0][4], path[0][5]], path });
              }
            : undefined
        }
      />
      {comparison && <CompareSummary comparison={comparison} onClear={() => void extras.compareWith(null)} />}
      {tip && !selected && !placing && studio.tool === "select" && <HoverTip pick={tip.pick} at={tip.at} model={model} takeoff={takeoff} rollups={rollups} />}
      {selected && (
        <div ref={cardRef} className="absolute left-0 top-0 z-20 w-72" style={{ visibility: "hidden" }}>
          <SelectionCard
            pick={selected}
            model={model}
            takeoff={takeoff}
            rollups={rollups}
            canWrite={canWrite && !state.saving}
            onClose={() => onSelect(null)}
            onRoomFinish={onRoomFinish}
            onAssignRoom={onAssignRoom}
            onAddWall={onAddWall}
            onShowOnSheet={onShowOnSheet}
            onObjectEdit={onObjectEdit}
            onSection={(levelId, wallId) => sectionThroughWall(studio, viewerRef, levelId, wallId)}
          />
        </div>
      )}
      <ModelHint mode={mode} placing={!!placing} />
    </div>
  );
}

function HoverTip({
  pick,
  at,
  model,
  takeoff,
  rollups,
}: {
  pick: ModelPick;
  at: ScreenPoint;
  model: FloorplanModel;
  takeoff: Record<string, SurfaceTakeoffMap>;
  rollups: ConditionRollup[] | null;
}) {
  const level = model.levels.find((candidate) => candidate.id === pick.levelId);
  const counted = takeoff[pick.levelId]?.[pick.id];
  const condition = counted ? rollups?.find((row) => row.condition.id === counted.conditionId)?.condition : null;
  let title = "";
  let detail = "";
  if (pick.kind === "room") {
    const room = level?.rooms.find((candidate) => candidate.id === pick.id);
    title = `${room?.label ?? "Room"} · ${formatQuantity(room?.areaSqft ?? 0)} SF`;
  } else if (pick.kind === "wall") {
    const wall = level?.walls.find((candidate) => candidate.id === pick.id);
    const length = wall ? Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0) : 0;
    title = `Wall · ${feetInches(length)} × ${feetInches(wall?.heightFt ?? level?.ceilingHeightFt ?? 0)}`;
  } else if (pick.kind === "object") {
    const object = level?.objects?.find((candidate) => candidate.id === pick.id);
    title = object?.name ?? "Object";
    detail = "Drag to move";
  } else title = "Roof";
  if (pick.kind === "room" || pick.kind === "wall") detail = condition ? `In ${condition.name}` : "Not in the takeoff";
  return (
    <div
      className="pointer-events-none absolute z-20 grid gap-0.5 bg-foreground px-2 py-1 text-xs text-background"
      style={{ transform: `translate(${at.x + 16}px, ${at.y + 16}px)` }}
    >
      <span className="font-medium">{title}</span>
      {detail && <span className={cn(!condition && (pick.kind === "room" || pick.kind === "wall") && "text-warning")}>{detail}</span>}
    </div>
  );
}

function SelectionCard({
  pick,
  model,
  takeoff,
  rollups,
  canWrite,
  onClose,
  onRoomFinish,
  onAssignRoom,
  onAddWall,
  onShowOnSheet,
  onObjectEdit,
  onSection,
}: {
  pick: ModelPick;
  model: FloorplanModel;
  takeoff: Record<string, SurfaceTakeoffMap>;
  rollups: ConditionRollup[] | null;
  canWrite: boolean;
  onClose: () => void;
  onRoomFinish: ModelPaneProps["onRoomFinish"];
  onAssignRoom: ModelPaneProps["onAssignRoom"];
  onAddWall: ModelPaneProps["onAddWall"];
  onShowOnSheet: ModelPaneProps["onShowOnSheet"];
  onObjectEdit: ModelPaneProps["onObjectEdit"];
  onSection: (levelId: string, wallId: string) => void;
}) {
  const level = model.levels.find((candidate) => candidate.id === pick.levelId);
  const counted = takeoff[pick.levelId]?.[pick.id];
  const condition = counted ? (rollups?.find((row) => row.condition.id === counted.conditionId)?.condition ?? null) : null;
  const areaItems = (rollups ?? []).filter((row) => (row.condition.uom === "sf" || row.condition.uom === "sy") && !row.condition.height_ft && !row.condition.pitch_rise);
  const header = (title: string, note: string) => (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <button type="button" onClick={onClose} className="grid size-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
        <X className="size-3.5" />
      </button>
    </div>
  );
  const sheetButton = (
    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onShowOnSheet(pick)}>
      Show on {level?.source.sheetNumber ?? "the sheet"}
    </Button>
  );

  let body: React.ReactNode = null;
  if (pick.kind === "room" && level) {
    const room = level.rooms.find((candidate) => candidate.id === pick.id);
    if (!room) return null;
    const current = Object.entries(FINISH_PRESETS).find(([, finish]) => finish.color === room.finish?.color && finish.pattern === room.finish?.pattern)?.[0];
    body = (
      <>
        {header(room.label ?? "Room", `${level.name} · ${formatQuantity(room.areaSqft)} SF · ${feetInches(room.ceilingHeightFt ?? level.ceilingHeightFt)} ceiling`)}
        <div className="space-y-1.5">
          <div className="microlabel">Floor finish</div>
          <div className="grid grid-cols-6 gap-1">
            {FLOOR_FINISHES.map((option) => {
              const finish = FINISH_PRESETS[option.key];
              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={!canWrite}
                  onClick={() => onRoomFinish(level.id, room.id, finish)}
                  className={cn("group grid gap-1 text-center text-[10px] text-muted-foreground disabled:opacity-60", current === option.key && "font-semibold text-foreground")}
                  aria-pressed={current === option.key}
                  aria-label={option.label}
                >
                  <span
                    className={cn("block aspect-square w-full border", current === option.key && "outline outline-2 outline-offset-1 outline-foreground")}
                    style={{ backgroundColor: finish.color }}
                  />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="microlabel">Counted in</div>
          {canWrite && areaItems.length > 0 ? (
            <select
              aria-label="Takeoff item for this room"
              className="h-8 w-full border bg-background px-2 text-sm"
              value={condition?.id ?? ""}
              onChange={(event) => event.target.value && onAssignRoom(level.id, room.id, event.target.value)}
            >
              <option value="" disabled>
                Not in the takeoff
              </option>
              {areaItems.map((row) => (
                <option key={row.condition.id} value={row.condition.id}>
                  {row.condition.name}
                </option>
              ))}
            </select>
          ) : (
            <p className={cn("text-sm", !condition && "text-warning")}>{condition ? condition.name : "Not in the takeoff"}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">{sheetButton}</div>
      </>
    );
  } else if (pick.kind === "wall" && level) {
    const wall = level.walls.find((candidate) => candidate.id === pick.id);
    if (!wall) return null;
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);
    const height = wall.heightFt ?? level.ceilingHeightFt;
    body = (
      <>
        {header("Wall", `${level.name} · ${feetInches(length)} long × ${feetInches(height)} high`)}
        <div className="font-mono text-lg font-semibold tabular-nums">
          {formatQuantity(length * height)} <span className="text-xs text-muted-foreground">SF</span>
        </div>
        <p className={cn("text-sm", !condition && "text-warning")}>{condition ? `Counted in ${condition.name}` : "This wall isn't in the takeoff."}</p>
        <div className="flex flex-wrap gap-1.5">
          {!condition && canWrite && (
            <Button size="sm" className="h-7 text-xs" onClick={() => onAddWall(level.id, wall.id)}>
              Add to takeoff
            </Button>
          )}
          {sheetButton}
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onSection(level.id, wall.id)}>
            <Scissors className="size-3" />
            Section here
          </Button>
        </div>
      </>
    );
  } else if (pick.kind === "object" && level) {
    const object = level.objects?.find((candidate) => candidate.id === pick.id);
    if (!object) return null;
    const issues = clearanceIssues(level).filter((issue) => issue.objectId === object.id);
    const piece = furnitureModel(object.modelId);
    const snap = snapToWall(level, object, 3);
    const room = roomContaining(level, object.xFt, object.yFt);
    body = (
      <>
        {header(object.name, `${feetInches(object.widthFt)} × ${feetInches(object.depthFt)} × ${feetInches(object.heightFt)} · drag to move`)}
        {issues.length > 0 ? (
          <ul className="space-y-1 text-xs text-warning">
            {issues.map((issue) => (
              <li key={`${issue.code}:${issue.otherId ?? ""}`} className="flex gap-1.5">
                <AlertTriangle className="mt-px size-3 shrink-0" />
                {issue.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="size-3" />
            Clear of walls, doors and other pieces
          </p>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-1.5">
            {snap && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onObjectEdit(level.id, { ...object, xFt: snap.xFt, yFt: snap.yFt, rotationDeg: snap.rotationDeg })}>
                <Magnet className="size-3" />
                Back to wall
              </Button>
            )}
            {room && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onObjectEdit(level.id, { ...object, ...placeInRoom(level, room, object, piece?.againstWall ?? false) })}
              >
                {piece?.againstWall ? "Best wall in room" : "Center in room"}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onObjectEdit(level.id, { ...object, rotationDeg: (object.rotationDeg + 90) % 360 })}>
              <RotateCw className="size-3" />
              Rotate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => onObjectEdit(level.id, { ...object, id: `object-${crypto.randomUUID()}`, xFt: object.xFt + 1.5, yFt: object.yFt + 1.5 })}
            >
              <Copy className="size-3" />
              Duplicate
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={() => onObjectEdit(level.id, null, object.id)}>
              <Trash2 className="size-3" />
              Remove
            </Button>
          </div>
        )}
      </>
    );
  } else {
    body = header("Roof", "Part of the model");
  }
  return <div className="space-y-3 border bg-popover p-3 shadow-lg">{body}</div>;
}

function CompareMenu({ extras }: { extras: ModelExtras }) {
  const active = extras.comparison;
  return (
    <DropdownMenu onOpenChange={(open) => open && extras.revisions === null && void extras.loadRevisions()}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 bg-card text-xs", active && "border-foreground")} aria-label="Compare with an earlier revision">
          <GitCompare className="size-3.5" />
          <span className="max-lg:hidden">Compare</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="microlabel">Compare with</DropdownMenuLabel>
        {extras.revisions === null ? (
          <div className="space-y-1.5 px-2 pb-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : extras.revisions.length === 0 ? (
          <p className="px-2 pb-2 text-xs text-muted-foreground">No earlier revisions yet. Every rebuild and correction keeps one.</p>
        ) : (
          extras.revisions.map((revision) => (
            <DropdownMenuItem key={revision.id} onSelect={() => void extras.compareWith(revision)} className="justify-between font-mono text-xs tabular-nums">
              {formatSavedAt(revision.saved_at)}
              {active?.revisionId === revision.id && <Check className="size-3.5" />}
            </DropdownMenuItem>
          ))
        )}
        {extras.compareError && <p className="px-2 pb-2 text-xs text-destructive">{extras.compareError}</p>}
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void extras.compareWith(null)}>Stop comparing</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompareSummary({ comparison, onClear }: { comparison: NonNullable<ModelExtras["comparison"]>; onClear: () => void }) {
  const { summary, delta } = comparison;
  const changed = summary.roomsAdded + summary.roomsRemoved + summary.roomsChanged + summary.wallsAdded + summary.wallsRemoved;
  const money = (cents: number) => `${cents < 0 ? "−" : "+"}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;
  return (
    <div className="absolute right-3 top-14 z-10 w-72 border bg-popover p-3 text-xs shadow-lg" role="status">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Since {formatSavedAt(comparison.savedAt)}</p>
          <p className="text-muted-foreground">{changed === 0 ? "Nothing in the building changed." : "Changes are coloured in the model."}</p>
        </div>
        <button type="button" onClick={onClear} className="grid size-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Stop comparing">
          <X className="size-3.5" />
        </button>
      </div>
      {changed > 0 && (
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono tabular-nums">
          {summary.roomsAdded > 0 && <Row tone="text-success" label="Rooms added" value={summary.roomsAdded} />}
          {summary.roomsChanged > 0 && <Row tone="text-warning" label="Rooms resized" value={summary.roomsChanged} />}
          {summary.roomsRemoved > 0 && <Row tone="text-destructive" label="Rooms removed" value={summary.roomsRemoved} />}
          {summary.wallsAdded > 0 && <Row tone="text-success" label="Walls added" value={summary.wallsAdded} />}
          {summary.wallsRemoved > 0 && <Row tone="text-destructive" label="Walls removed" value={summary.wallsRemoved} />}
        </dl>
      )}
      {delta.lines.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <div className="microlabel mb-1">Estimate</div>
          <ul className="space-y-0.5">
            {delta.lines.map((line) => (
              <li key={line.conditionId} className="flex justify-between gap-2">
                <span className="truncate">{line.name}</span>
                <span className="shrink-0 font-mono tabular-nums">
                  {line.deltaSqft > 0 ? "+" : ""}
                  {formatQuantity(line.deltaSqft)} SF
                  {line.deltaCents !== null && <span className={cn("ml-2", line.deltaCents < 0 ? "text-success" : "text-warning")}>{money(line.deltaCents)}</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1.5 flex justify-between border-t pt-1.5 font-semibold">
            <span>Priced change</span>
            <span className="font-mono tabular-nums">{money(delta.totalCents)}</span>
          </div>
          {delta.unpriced.length > 0 && <p className="mt-1 text-muted-foreground">Not priced here: {delta.unpriced.join(", ")}</p>}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <>
      <dt className="font-sans text-muted-foreground">{label}</dt>
      <dd className={cn("text-right", tone)}>{value}</dd>
    </>
  );
}

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function feetInches(feet: number): string {
  const total = Math.round(feet * 12);
  return `${Math.floor(total / 12)}'-${total % 12}"`;
}

