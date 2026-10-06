"use client";

/**
 * The second row of model controls: the tools for looking harder — measure,
 * section, sun, photo, walkthrough, VR. Shared by the drawings workspace and
 * the model stages, which differ only in which tools they offer.
 *
 * `useModelStudio` owns their state; spread `studio.viewerProps` onto the
 * `ModelViewer` and render `<ModelTools studio={studio} … />` over it.
 */

import { useEffect, useState, type RefObject } from "react";
import { BoxSelect, Camera, Circle, Download, FlipHorizontal2, Glasses, Ruler, Square, Sun, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { SiteOrientation } from "@/lib/drawings/architectural-model";
import type { TourSample } from "@/lib/plans/camera-tour";
import { DEFAULT_SITE, formatSolarHour } from "@/lib/plans/sun-position";
import { formatFeetInches } from "@/lib/validation/drawings";
import { cn } from "@/lib/utils";

import { modelXrSupported, type ModelMeasurement, type ModelTool, type ModelViewerHandle } from "./model-viewer";

export function useModelStudio() {
  const [tool, setTool] = useState<ModelTool>("select");
  const [sectionBox, setSectionBox] = useState(false);
  const [sectionPlane, setSectionPlane] = useState(false);
  const [sunHour, setSunHour] = useState(15);
  const [photo, setPhoto] = useState<number | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [touring, setTouring] = useState(false);
  const [measurements, setMeasurements] = useState<ModelMeasurement[]>([]);
  const [xr, setXr] = useState(false);
  useEffect(() => {
    let live = true;
    void modelXrSupported().then((supported) => live && setXr(supported));
    return () => {
      live = false;
    };
  }, []);
  return {
    tool,
    setTool,
    sectionBox,
    setSectionBox,
    sectionPlane,
    setSectionPlane,
    sunHour,
    setSunHour,
    photo,
    recordingSince,
    setRecordingSince,
    touring,
    setTouring,
    measurements,
    xr,
    viewerProps: {
      tool,
      sectionBox,
      sunHour,
      onPhoto: setPhoto,
      onMeasure: setMeasurements,
      onTourEnd: () => setTouring(false),
    },
  };
}

export type ModelStudio = ReturnType<typeof useModelStudio>;

/** Cut along a wall: the box goes away first, then the plane goes in once the viewer has caught up. */
export function sectionThroughWall(studio: ModelStudio, viewerRef: RefObject<ModelViewerHandle | null>, levelId: string, wallId: string) {
  studio.setSectionBox(false);
  studio.setSectionPlane(true);
  requestAnimationFrame(() => viewerRef.current?.sectionThrough(levelId, wallId));
}

const toolButton = "size-8 border bg-card text-muted-foreground hover:border-line-strong hover:text-foreground aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background";

export function ModelTools({
  studio,
  viewerRef,
  fileName,
  offer = { measure: true, section: true, photo: true, record: true },
  site,
  onSite,
  onSaveTour,
  className,
}: {
  studio: ModelStudio;
  viewerRef: RefObject<ModelViewerHandle | null>;
  fileName: string;
  offer?: { measure?: boolean; section?: boolean; photo?: boolean; record?: boolean };
  /** The model's site; editable only when `onSite` is given. */
  site?: SiteOrientation;
  onSite?: (site: SiteOrientation) => void;
  /** Recording is offered only where a walkthrough can be saved. */
  onSaveTour?: (samples: TourSample[]) => void;
  className?: string;
}) {
  const viewer = viewerRef.current;
  const measuring = studio.tool === "measure";
  const recording = studio.recordingSince !== null;
  const sectioned = studio.sectionBox || studio.sectionPlane;

  const stopRecording = () => {
    const samples = viewerRef.current?.stopRecording() ?? null;
    studio.setRecordingSince(null);
    if (samples) onSaveTour?.(samples);
  };

  return (
    <>
      <div className={cn("pointer-events-none absolute bottom-10 left-3 z-10 flex flex-col items-start gap-1.5", className)}>
        <div className="pointer-events-auto flex gap-1" role="toolbar" aria-label="Model tools">
          {offer.measure && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolButton}
              aria-pressed={measuring}
              title="Measure (snaps to corners and edges)"
              aria-label="Measure"
              onClick={() => studio.setTool(measuring ? "select" : "measure")}
            >
              <Ruler className="size-4" />
            </Button>
          )}
          {offer.section && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolButton}
              aria-pressed={studio.sectionBox}
              title="Section box — drag the handles to cut"
              aria-label="Section box"
              onClick={() => {
                studio.setSectionPlane(false);
                studio.setSectionBox(!studio.sectionBox);
              }}
            >
              <BoxSelect className="size-4" />
            </Button>
          )}
          <SunControl hour={studio.sunHour} onHour={studio.setSunHour} site={site} onSite={onSite} />
          {offer.photo && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolButton}
              aria-pressed={studio.photo !== null}
              title="Render a photo of this view"
              aria-label="Render photo"
              onClick={() => (studio.photo === null ? viewerRef.current?.startPhoto() : viewerRef.current?.stopPhoto())}
            >
              <Camera className="size-4" />
            </Button>
          )}
          {offer.record && onSaveTour && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolButton}
              aria-pressed={recording}
              title={recording ? "Stop and save the walkthrough" : "Record a walkthrough"}
              aria-label={recording ? "Stop recording" : "Record walkthrough"}
              onClick={() => {
                if (recording) stopRecording();
                else {
                  viewerRef.current?.startRecording();
                  studio.setRecordingSince(Date.now());
                }
              }}
            >
              {recording ? <Square className="size-3.5 fill-current" /> : <Circle className="size-3.5" />}
            </Button>
          )}
          {studio.xr && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolButton}
              title="Stand in it with a headset"
              aria-label="View in VR"
              onClick={() => void viewerRef.current?.enterXR()}
            >
              <Glasses className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <StatusStrip>
        {studio.photo !== null && (
          <Status
            label={studio.photo < 1 ? `Rendering photo · ${Math.round(studio.photo * 100)}%` : "Photo ready"}
            progress={studio.photo}
            actions={
              <>
                <StripButton onClick={() => viewer?.exportImage(`${fileName}-photo`)}>
                  <Download className="size-3" />
                  Download
                </StripButton>
                <StripButton onClick={() => viewer?.stopPhoto()} aria-label="Leave photo">
                  <X className="size-3" />
                </StripButton>
              </>
            }
          />
        )}
        {recording && <RecordingStatus since={studio.recordingSince ?? Date.now()} onStop={stopRecording} />}
        {studio.touring && (
          <Status
            label="Playing walkthrough"
            actions={
              <StripButton onClick={() => viewer?.stopTour()} aria-label="Stop walkthrough">
                <X className="size-3" />
              </StripButton>
            }
          />
        )}
        {measuring && (
          <Status
            label={
              studio.measurements.length === 0
                ? "Click two points — corners and edges snap"
                : studio.measurements.map((measurement) => formatFeetInches(measurement.lengthFt)).join(" · ")
            }
            actions={
              studio.measurements.length > 0 ? (
                <StripButton onClick={() => viewer?.clearMeasurements()}>Clear</StripButton>
              ) : null
            }
          />
        )}
        {sectioned && (
          <Status
            label={studio.sectionBox ? "Section box — drag a handle to cut" : "Section through wall"}
            actions={
              <>
                {studio.sectionPlane && (
                  <StripButton onClick={() => viewer?.flipSection()}>
                    <FlipHorizontal2 className="size-3" />
                    Flip
                  </StripButton>
                )}
                <StripButton
                  onClick={() => {
                    studio.setSectionBox(false);
                    studio.setSectionPlane(false);
                    viewer?.clearSection();
                  }}
                  aria-label="Clear section"
                >
                  <X className="size-3" />
                </StripButton>
              </>
            }
          />
        )}
      </StatusStrip>
    </>
  );
}

function SunControl({
  hour,
  onHour,
  site,
  onSite,
}: {
  hour: number;
  onHour: (hour: number) => void;
  site?: SiteOrientation;
  onSite?: (site: SiteOrientation) => void;
}) {
  const current = site ?? DEFAULT_SITE;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={toolButton} title="Sun and shadows" aria-label="Sun and shadows">
          <Sun className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 space-y-3 p-3">
        <div className="flex items-baseline justify-between">
          <span className="microlabel">Sun</span>
          <span className="font-mono text-xs tabular-nums">{formatSolarHour(hour)}</span>
        </div>
        <Slider min={5} max={21} step={0.25} value={[hour]} onValueChange={([value]) => onHour(value)} aria-label="Time of day" />
        <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>5 AM</span>
          <span>Noon</span>
          <span>9 PM</span>
        </div>
        {onSite ? (
          <div className="grid grid-cols-2 gap-2 border-t pt-3">
            <SiteField label="North (°)" value={current.northDeg} min={-360} max={360} onCommit={(northDeg) => onSite({ ...current, northDeg })} />
            <SiteField label="Latitude (°)" value={current.latitudeDeg} min={-66} max={66} onCommit={(latitudeDeg) => onSite({ ...current, latitudeDeg })} />
            <p className="col-span-2 text-[11px] text-muted-foreground">North is the bearing of the sheet&apos;s up, clockwise. Today&apos;s date sets the season.</p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Today&apos;s sun at this site.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SiteField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) onCommit(parsed);
    else setDraft(String(value));
  };
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
        className="h-7 text-right font-mono text-xs tabular-nums"
      />
    </label>
  );
}

function StatusStrip({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-x-3 bottom-10 z-10 flex flex-col items-center gap-1.5">{children}</div>;
}

function Status({ label, progress, actions }: { label: string; progress?: number; actions?: React.ReactNode }) {
  return (
    <div className="pointer-events-auto relative flex items-center gap-2 overflow-hidden border bg-popover py-1 pl-3 pr-1 text-xs shadow-lg" role="status">
      <span className="font-medium tabular-nums">{label}</span>
      <span className="flex items-center">{actions}</span>
      {progress !== undefined && progress < 1 && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-muted" aria-hidden>
          <span className="block h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

function StripButton({ children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" {...props}>
      {children}
    </Button>
  );
}

function RecordingStatus({ since, onStop }: { since: number; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <Status
      label={`Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
      actions={
        <StripButton onClick={onStop}>
          <span className="size-2 rounded-full bg-destructive" aria-hidden />
          Stop & save
        </StripButton>
      }
    />
  );
}
