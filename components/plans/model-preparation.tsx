"use client";
import Image from "next/image";
import { useEffect, useState } from "react";
import { loadFloorplanSourcesAction } from "@/app/(app)/floorplan/actions";
import { unwrapAction } from "@/lib/action-result";
import type { ModelSourceSelection } from "@/lib/drawings/architectural-model";
import type { FloorplanTarget } from "@/lib/services/floorplan-models";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Source = {
  sheetVersionId: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  imageWidth: number;
  imageHeight: number;
  thumbnailUrl: string | null;
  feetPerImagePx: number | null;
};
export function ModelPreparation({
  target,
  open,
  onClose,
  onGenerate,
  busy,
}: {
  target: FloorplanTarget;
  open: boolean;
  onClose: () => void;
  onGenerate: (sources: ModelSourceSelection[]) => void;
  busy: boolean;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<ModelSourceSelection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key =
    target.kind === "project" ? target.projectId : target.housePlanVersionId;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadFloorplanSourcesAction(target)
      .then((result) => {
        if (!cancelled) setSources(unwrapAction(result));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The target's scalar anchor is stable across parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);
  useEffect(() => {
    setSelected([]);
    setSources([]);
  }, [key]);
  const update = (
    choice: ModelSourceSelection,
    value: Partial<ModelSourceSelection>,
  ) =>
    setSelected((rows) =>
      rows.map((r) => (r === choice ? { ...r, ...value } : r)),
    );
  const invalid =
    !selected.length ||
    selected.some(
      (s) =>
        !s.name.trim() ||
        !(s.feetPerImagePx > 0) ||
        s.region.x1 <= s.region.x0 ||
        s.region.y1 <= s.region.y0,
    ) ||
    new Set(selected.map((s) => s.order)).size !== selected.length;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Prepare your home model</DialogTitle>
          <DialogDescription>
            Choose the plan for each floor. Confirm scale and wall height, and
            crop out details or alternate plans. Each floor needs a unique
            order.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="py-8 text-sm text-muted-foreground">
            Loading current drawings…
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : !sources.length ? (
          <p className="py-8 text-sm">
            Upload and publish a drawing set to prepare a model.
          </p>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => {
              const choices = selected.filter(
                (s) => s.sheetVersionId === source.sheetVersionId,
              );
              return (
                <div
                  key={source.sheetVersionId}
                  className={`rounded-lg border p-3 ${choices.length ? "border-primary/40 bg-secondary/20" : ""}`}
                >
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={choices.length > 0}
                      onChange={(e) =>
                        setSelected((rows) =>
                          e.target.checked
                            ? [
                                ...rows,
                                {
                                  sheetVersionId: source.sheetVersionId,
                                  name:
                                    source.sheetTitle ??
                                    `Floor ${rows.length + 1}`,
                                  order:
                                    Math.max(
                                      -1,
                                      ...rows.map((row) => row.order),
                                    ) + 1,
                                  region: { x0: 0, y0: 0, x1: 1, y1: 1 },
                                  feetPerImagePx: source.feetPerImagePx ?? 0,
                                  ceilingHeightFt: 9,
                                },
                              ]
                            : rows.filter(
                                (r) =>
                                  r.sheetVersionId !== source.sheetVersionId,
                              ),
                        )
                      }
                    />
                    <span className="text-sm font-medium">
                      {source.sheetNumber} ·{" "}
                      {source.sheetTitle ?? "Untitled sheet"}
                    </span>
                  </label>
                  {choices.map((choice, choiceIndex) => (
                    <div
                      key={choiceIndex}
                      className="mt-3 space-y-3 border-t pt-3"
                    >
                      {choices.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSelected((rows) =>
                              rows.filter((row) => row !== choice),
                            )
                          }
                        >
                          Remove this floor
                        </Button>
                      )}
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <label className="text-xs">
                          Floor name
                          <Input
                            value={choice.name}
                            onChange={(e) =>
                              update(choice, {
                                name: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          Floor order
                          <Input
                            type="number"
                            value={choice.order}
                            onChange={(e) =>
                              update(choice, {
                                order: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          Feet per image pixel
                          <Input
                            type="number"
                            step="0.000001"
                            min="0.000001"
                            value={choice.feetPerImagePx}
                            onChange={(e) =>
                              update(choice, {
                                feetPerImagePx: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          Wall height · ft
                          <Input
                            type="number"
                            min="6"
                            max="20"
                            value={choice.ceilingHeightFt}
                            onChange={(e) =>
                              update(choice, {
                                ceilingHeightFt: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                      <SourceRegion
                        source={source}
                        choice={choice}
                        onScale={(feetPerImagePx) =>
                          update(choice, { feetPerImagePx })
                        }
                        onChange={(region) => update(choice, { region })}
                      />
                      <div className="grid grid-cols-4 gap-2">
                        {(["x0", "y0", "x1", "y1"] as const).map((k) => (
                          <label key={k} className="text-xs">
                            {k}
                            <Input
                              type="number"
                              min="0"
                              max="1"
                              step="0.01"
                              value={choice.region[k]}
                              onChange={(e) =>
                                update(choice, {
                                  region: {
                                    ...choice.region,
                                    [k]: Number(e.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  {choices.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={busy}
                      onClick={() =>
                        setSelected((rows) => [
                          ...rows,
                          {
                            ...choices[0],
                            name: `Floor ${rows.length + 1}`,
                            order:
                              Math.max(-1, ...rows.map((row) => row.order)) + 1,
                          },
                        ])
                      }
                    >
                      Add another floor from this sheet
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {selected.length} floors selected
          </span>
          <Button
            disabled={busy || loading || invalid}
            onClick={() => onGenerate(selected)}
          >
            {busy ? "Starting…" : "Generate editable model"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function SourceRegion({
  source,
  choice,
  onChange,
  onScale,
}: {
  source: Source;
  choice: ModelSourceSelection;
  onChange: (r: ModelSourceSelection["region"]) => void;
  onScale: (scale: number) => void;
}) {
  const [mode, setMode] = useState<"crop" | "scale">("crop");
  const [lengthFt, setLengthFt] = useState(10);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  const r =
    mode === "crop" && start && end
      ? {
          x0: Math.min(start.x, end.x),
          y0: Math.min(start.y, end.y),
          x1: Math.max(start.x, end.x),
          y1: Math.max(start.y, end.y),
        }
      : choice.region;
  return source.thumbnailUrl ? (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {mode === "crop"
          ? "Drag a rectangle around the floorplan."
          : "Enter a known length in feet, then drag along that dimension."}
      </p>
      <div className="mb-2 flex items-end gap-2">
        <Button
          size="sm"
          variant={mode === "crop" ? "secondary" : "outline"}
          onClick={() => setMode("crop")}
        >
          Crop floor
        </Button>
        <Button
          size="sm"
          variant={mode === "scale" ? "secondary" : "outline"}
          onClick={() => setMode("scale")}
        >
          Calibrate scale
        </Button>
        {mode === "scale" && (
          <label className="text-xs">
            Known length · ft
            <Input
              type="number"
              min="0.01"
              step="any"
              value={lengthFt}
              onChange={(e) => setLengthFt(Number(e.target.value))}
            />
          </label>
        )}
      </div>
      <div
        className="relative w-full touch-none overflow-hidden bg-white"
        style={{ aspectRatio: `${source.imageWidth}/${source.imageHeight}` }}
        onPointerDown={(e) => {
          setStart(point(e));
          setEnd(point(e));
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (start) setEnd(point(e));
        }}
        onPointerCancel={() => {
          setStart(null);
          setEnd(null);
        }}
        onPointerUp={(e) => {
          if (!start) return;
          const end = point(e);
          if (mode === "scale") {
            const pixels = Math.hypot(
              (end.x - start.x) * source.imageWidth,
              (end.y - start.y) * source.imageHeight,
            );
            if (pixels > 5 && lengthFt > 0) onScale(lengthFt / pixels);
          } else if (
            Math.abs(end.x - start.x) > 0.02 &&
            Math.abs(end.y - start.y) > 0.02
          )
            onChange({
              x0: Math.min(start.x, end.x),
              y0: Math.min(start.y, end.y),
              x1: Math.max(start.x, end.x),
              y1: Math.max(start.y, end.y),
            });
          setStart(null);
          setEnd(null);
        }}
      >
        {mode === "scale" && start && end && (
          <svg
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 z-10 h-full w-full"
          >
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="currentColor"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
              className="text-primary"
            />
          </svg>
        )}
        <Image
          src={source.thumbnailUrl}
          alt={`${source.sheetNumber} plan region`}
          fill
          unoptimized
          className="pointer-events-none object-fill"
        />
        <div
          className="pointer-events-none absolute border-2 border-primary bg-primary/10"
          style={{
            left: `${r.x0 * 100}%`,
            top: `${r.y0 * 100}%`,
            width: `${(r.x1 - r.x0) * 100}%`,
            height: `${(r.y1 - r.y0) * 100}%`,
          }}
        />
      </div>
    </div>
  ) : null;
}
