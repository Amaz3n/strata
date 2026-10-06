"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FINISH_PRESETS,
  MODEL_MATERIAL_COLORS,
  OBJECT_PRESETS,
  type BuildingObject,
  type SurfaceFinish,
} from "@/lib/drawings/architectural-model";
import { validateArchitecturalModel } from "@/lib/drawings/architectural-validation";
import { interiorPoint } from "@/lib/drawings/architectural-polygon";
import { openingWidthNote } from "@/lib/drawings/opening-dimensions";
import {
  openingProfile,
  wallLengthFt,
  type FloorplanModel,
  type FloorplanEdit,
  type Level,
} from "@/lib/drawings/floorplan-model";

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";
function NumberField({
  name,
  label,
  value,
  min,
  max,
}: {
  name: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        name={name}
        type="number"
        step="any"
        min={min}
        max={max}
        defaultValue={value}
        required
        className="h-8 text-foreground"
      />
    </label>
  );
}
function Fields({
  children,
  onSubmit,
  disabled,
}: {
  children: React.ReactNode;
  onSubmit: (data: FormData) => void;
  disabled: boolean;
}) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <fieldset disabled={disabled} className="grid grid-cols-2 gap-2">
        {children}
      </fieldset>
      <Button type="submit" size="sm" disabled={disabled}>
        Apply changes
      </Button>
    </form>
  );
}
const n = (data: FormData, key: string) => Number(data.get(key));

export function ModelInspector({
  model,
  level,
  selection,
  onSelect,
  onEdit,
  disabled,
}: {
  model: FloorplanModel;
  level: Level;
  selection: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (edit: FloorplanEdit) => void;
  disabled: boolean;
}) {
  const [tab, setTab] = useState("structure");
  const [resolutionNote, setResolutionNote] = useState("");
  const selectedIssue = level.reconstruction?.issues.find(
    (i) =>
      !level.reconstruction?.resolutions?.some((r) => r.issueId === i.id) &&
      (selection === `reconstruction:${i.id}` ||
        selection?.startsWith(`reconstruction:${i.id}:member:`) ||
        (i.objectId && selection === i.objectId)),
  );
  const [objectKind, setObjectKind] = useState<BuildingObject["kind"]>("sofa");
  const wall = level.walls.find((w) => w.id === selection);
  const room = level.rooms.find((r) => r.id === selection);
  const opening = level.openings.find((o) => o.id === selection);
  const object = level.objects?.find((o) => o.id === selection);
  const placement = level.placement ?? {
    xFt: 0,
    yFt: 0,
    rotationDeg: 0,
    elevationFt: 0,
    assemblyFt: 1,
    confirmed: false,
  };
  const issues = validateArchitecturalModel(model).filter(
    (i) => !i.levelId || i.levelId === level.id,
  );
  const setFinish = (finish: SurfaceFinish) => {
    if (wall)
      onEdit({
        type: "wall.update",
        levelId: level.id,
        wallId: wall.id,
        changes: { finish },
      });
    else if (room)
      onEdit({
        type: "room.update",
        levelId: level.id,
        roomId: room.id,
        changes: { finish },
      });
  };
  const addObject = () => {
    const preset = OBJECT_PRESETS[objectKind];
    const [xFt, yFt] = level.rooms.length
      ? interiorPoint(level.rooms[0].polygon, level.rooms[0].holes)
      : [0, 0];
    const id = `object-${crypto.randomUUID()}`;
    onEdit({
      type: "object.upsert",
      levelId: level.id,
      object: {
        ...preset,
        id,
        kind: objectKind,
        xFt,
        yFt,
        elevationFt: 0,
        rotationDeg: 0,
        color: MODEL_MATERIAL_COLORS.furniture,
      },
    });
    onSelect(id);
  };
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l bg-card md:w-80 md:shrink-0">
      <div className="border-b p-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Model studio
        </p>
        <h3 className="mt-1 font-medium">{level.name}</h3>
      </div>
      <div
        className="grid grid-cols-4 border-b p-1"
        role="tablist"
        aria-label="Model tools"
      >
        {["structure", "finishes", "furnish", "review"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded px-1 py-2 text-xs capitalize ${tab === t ? "bg-secondary font-medium" : "text-muted-foreground"}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {selectedIssue && (
          <div className="grid gap-2 rounded-md border border-border p-3 text-xs">
            <p>{selectedIssue.message}</p>
            {selectedIssue.members && selectedIssue.members.length > 0 && (
              <>
                <p className="text-muted-foreground">
                  Review every interval in this group before recording its
                  resolution. Select an interval to locate it on the drawing.
                </p>
                <details>
                  <summary className="cursor-pointer">
                    {selectedIssue.members.length} source intervals
                  </summary>
                  <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                    {selectedIssue.members.map((member, index) => (
                      <li key={`${member.id}:${index}`}>
                        <button
                          type="button"
                          className="w-full rounded border p-2 text-left"
                          onClick={() =>
                            onSelect(
                              `reconstruction:${selectedIssue.id}:member:${index}`,
                            )
                          }
                        >
                          <span className="font-medium">
                            Interval {index + 1}
                          </span>
                          <span className="mt-1 block text-muted-foreground">
                            {member.message}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              </>
            )}
            {selectedIssue.point && (
              <p className="text-muted-foreground">
                {selectedIssue.members?.length
                  ? "Outlined markers show the group or the selected interval on the source drawing."
                  : "The outlined marker shows this location on the source drawing."}
              </p>
            )}
            {selectedIssue.severity === "review" && (
              <>
                <Input
                  aria-label="Recognition correction note"
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  placeholder="Describe what you corrected or verified"
                />
                <Button
                  size="sm"
                  disabled={disabled || resolutionNote.trim().length < 8}
                  onClick={() => {
                    onEdit({
                      type: "reconstruction.resolve",
                      levelId: level.id,
                      issueId: selectedIssue.id,
                      note: resolutionNote,
                    });
                    setResolutionNote("");
                    onSelect(null);
                    setTab("review");
                  }}
                >
                  Record resolution
                </Button>
              </>
            )}
          </div>
        )}
        {tab !== "review" && (
          <label className="grid gap-2 text-xs text-muted-foreground">
            Selected element
            <select
              aria-label="Selected element"
              className={selectClass}
              value={selection ?? ""}
              onChange={(e) => onSelect(e.target.value || null)}
            >
              <option value="">Floor settings</option>
              {level.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? "Room"} · {r.id}
                </option>
              ))}
              {level.walls.map((w) => (
                <option key={w.id} value={w.id}>
                  Wall {w.id} · {wallLengthFt(w).toFixed(1)} ft
                </option>
              ))}
              {level.openings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.kind} · {o.id}
                </option>
              ))}
              {level.objects?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {tab === "structure" && (
          <div
            key={`${selection}:${model.correctionCount}`}
            className="space-y-4"
          >
            {wall ? (
              <>
                <Fields
                  disabled={disabled}
                  onSubmit={(d) =>
                    onEdit({
                      type: "wall.update",
                      levelId: level.id,
                      wallId: wall.id,
                      changes: {
                        x0: n(d, "x0"),
                        y0: n(d, "y0"),
                        x1: n(d, "x1"),
                        y1: n(d, "y1"),
                        thicknessFt: n(d, "thickness"),
                        heightFt: n(d, "height"),
                      },
                    })
                  }
                >
                  <NumberField name="x0" label="Start X · ft" value={wall.x0} />
                  <NumberField name="y0" label="Start Y · ft" value={wall.y0} />
                  <NumberField name="x1" label="End X · ft" value={wall.x1} />
                  <NumberField name="y1" label="End Y · ft" value={wall.y1} />
                  <NumberField
                    name="thickness"
                    label="Thickness · ft"
                    min={0.1}
                    max={4}
                    value={wall.thicknessFt}
                  />
                  <NumberField
                    name="height"
                    label="Height · ft"
                    min={0.5}
                    max={40}
                    value={wall.heightFt ?? level.ceilingHeightFt}
                  />
                </Fields>
                <div className="flex gap-2">
                  {(["door", "window", "cased"] as const).map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      disabled={disabled || wallLengthFt(wall) < 3}
                      onClick={() => {
                        const id = `opening-${crypto.randomUUID()}`;
                        onEdit({
                          type: "opening.upsert",
                          levelId: level.id,
                          opening: {
                            id,
                            wallId: wall.id,
                            kind,
                            offsetFt: Math.max(0, (wallLengthFt(wall) - 3) / 2),
                            widthFt: 3,
                            ...openingProfile(kind),
                            confidence: 1,
                            style: kind === "window" ? "fixed" : "hinged",
                          },
                        });
                        onSelect(id);
                      }}
                    >
                      {kind}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    onEdit({
                      type: "wall.delete",
                      levelId: level.id,
                      wallId: wall.id,
                    })
                  }
                >
                  Delete wall
                </Button>
              </>
            ) : opening ? (
              <>
                <Fields
                  disabled={disabled}
                  onSubmit={(d) =>
                    onEdit({
                      type: "opening.upsert",
                      levelId: level.id,
                      opening: {
                        ...opening,
                        offsetFt: n(d, "offset"),
                        widthFt: n(d, "width"),
                        sillFt: n(d, "sill"),
                        headFt: n(d, "head"),
                        style: d.get("style") as typeof opening.style,
                        handing: d.get("handing") as "left" | "right",
                        swing: d.get("swing") as "in" | "out",
                      },
                    })
                  }
                >
                  <NumberField
                    name="offset"
                    label="Offset on wall · ft"
                    value={opening.offsetFt}
                    min={0}
                  />
                  <NumberField
                    name="width"
                    label="Width · ft"
                    value={opening.widthFt}
                    min={0.1}
                  />
                  {opening.kind === "window" && (
                    <p className="col-span-2 text-xs text-muted-foreground">
                      {openingWidthNote(opening.widthBasis)}
                    </p>
                  )}
                  <NumberField
                    name="sill"
                    label="Sill · ft"
                    value={opening.sillFt}
                    min={0}
                  />
                  <NumberField
                    name="head"
                    label="Head · ft"
                    value={opening.headFt}
                    min={0.1}
                  />
                  <label className="grid gap-1 text-xs">
                    Style
                    <select
                      name="style"
                      className={selectClass}
                      defaultValue={opening.style ?? "hinged"}
                    >
                      {[
                        "hinged",
                        "double",
                        "sliding",
                        "pocket",
                        "garage",
                        "fixed",
                      ].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Hinge
                    <select
                      name="handing"
                      className={selectClass}
                      defaultValue={opening.handing ?? "left"}
                    >
                      <option>left</option>
                      <option>right</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Swing
                    <select
                      name="swing"
                      className={selectClass}
                      defaultValue={opening.swing ?? "in"}
                    >
                      <option value="in">Into the room</option>
                      <option value="out">Out of the room</option>
                    </select>
                  </label>
                </Fields>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    onEdit({
                      type: "opening.delete",
                      levelId: level.id,
                      openingId: opening.id,
                    })
                  }
                >
                  Remove opening
                </Button>
              </>
            ) : room ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {room.areaSqft.toFixed(1)} sq ft · Interior boundary
                </p>
                <Fields
                  disabled={disabled}
                  onSubmit={(d) =>
                    onEdit({
                      type: "room.update",
                      levelId: level.id,
                      roomId: room.id,
                      changes: { ceilingHeightFt: n(d, "height") },
                    })
                  }
                >
                  <NumberField
                    name="height"
                    label="Ceiling height · ft"
                    value={room.ceilingHeightFt ?? level.ceilingHeightFt}
                    min={6}
                    max={40}
                  />
                </Fields>
                <p className="text-xs text-muted-foreground">
                  Add a rectangular opening for a stairwell or double-height
                  space.
                </p>
                <Fields
                  disabled={disabled}
                  onSubmit={(d) => {
                    const x = n(d, "x"),
                      y = n(d, "y"),
                      w = n(d, "w"),
                      h = n(d, "h");
                    onEdit({
                      type: "room.update",
                      levelId: level.id,
                      roomId: room.id,
                      changes: {
                        holes: [
                          ...(room.holes ?? []),
                          [
                            [x, y],
                            [x + w, y],
                            [x + w, y + h],
                            [x, y + h],
                          ],
                        ],
                      },
                    });
                  }}
                >
                  <NumberField
                    name="x"
                    label="Opening X · ft"
                    value={room.polygon[0][0] + 1}
                  />
                  <NumberField
                    name="y"
                    label="Opening Y · ft"
                    value={room.polygon[0][1] + 1}
                  />
                  <NumberField
                    name="w"
                    label="Width · ft"
                    value={3}
                    min={0.1}
                  />
                  <NumberField
                    name="h"
                    label="Depth · ft"
                    value={6}
                    min={0.1}
                  />
                </Fields>
                {room.holes?.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      onEdit({
                        type: "room.update",
                        levelId: level.id,
                        roomId: room.id,
                        changes: { holes: [] },
                      })
                    }
                  >
                    Remove floor openings
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Align floors using the same building corner. Positions and
                  elevations are in feet.
                </p>
                <Fields
                  disabled={disabled}
                  onSubmit={(d) =>
                    onEdit({
                      type: "level.placement",
                      levelId: level.id,
                      placement: {
                        xFt: n(d, "x"),
                        yFt: n(d, "y"),
                        rotationDeg: n(d, "rotation"),
                        elevationFt: n(d, "elevation"),
                        assemblyFt: n(d, "assembly"),
                        confirmed: true,
                      },
                    })
                  }
                >
                  <NumberField
                    name="x"
                    label="Building X"
                    value={placement.xFt}
                  />
                  <NumberField
                    name="y"
                    label="Building Y"
                    value={placement.yFt}
                  />
                  <NumberField
                    name="rotation"
                    label="Rotation · degrees"
                    value={placement.rotationDeg}
                  />
                  <NumberField
                    name="elevation"
                    label="Floor elevation"
                    value={placement.elevationFt}
                  />
                  <NumberField
                    name="assembly"
                    label="Floor assembly"
                    value={placement.assemblyFt}
                    min={0}
                    max={10}
                  />
                </Fields>
                <details className="border-t pt-3">
                  <summary className="cursor-pointer text-sm">
                    Roof massing
                  </summary>
                  <p className="my-2 text-xs text-muted-foreground">
                    Parametric envelope. Confirm its shape against elevations
                    before presentation.
                  </p>
                  <Fields
                    disabled={disabled}
                    onSubmit={(d) =>
                      onEdit({
                        type: "roof.set",
                        levelId: level.id,
                        roof: {
                          kind: d.get("kind") as "gable",
                          riseFt: n(d, "rise"),
                          overhangFt: n(d, "overhang"),
                          rotationDeg: n(d, "rotation"),
                          color: MODEL_MATERIAL_COLORS.roof,
                        },
                      })
                    }
                  >
                    <label className="text-xs">
                      Shape
                      <select
                        name="kind"
                        className={selectClass}
                        defaultValue={level.roof?.kind ?? "gable"}
                      >
                        <option>gable</option>
                        <option>hip</option>
                        <option>flat</option>
                      </select>
                    </label>
                    <NumberField
                      name="rise"
                      label="Rise · ft"
                      value={level.roof?.riseFt ?? 5}
                      min={0}
                    />
                    <NumberField
                      name="overhang"
                      label="Overhang · ft"
                      value={level.roof?.overhangFt ?? 1}
                      min={0}
                    />
                    <NumberField
                      name="rotation"
                      label="Ridge direction"
                      value={level.roof?.rotationDeg ?? 0}
                    />
                  </Fields>
                  {level.roof && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onEdit({
                          type: "roof.set",
                          levelId: level.id,
                          roof: null,
                        })
                      }
                    >
                      Remove roof
                    </Button>
                  )}
                </details>
              </>
            )}
          </div>
        )}
        {tab === "finishes" && (
          <>
            <p className="text-xs text-muted-foreground">
              Select a wall or room in the model to apply a finish.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(FINISH_PRESETS).map(([name, finish]) => (
                <button
                  key={name}
                  disabled={disabled || (!wall && !room)}
                  onClick={() => setFinish(finish)}
                  className="overflow-hidden rounded-lg border text-left disabled:opacity-40"
                >
                  <div
                    className="h-16"
                    style={{ backgroundColor: finish.color }}
                  />
                  <span className="block p-2 text-xs capitalize">{name}</span>
                </button>
              ))}
            </div>
            {(wall || room) && (
              <Fields
                key={`${selection}:${model.correctionCount}`}
                disabled={disabled}
                onSubmit={(d) =>
                  setFinish({
                    ...(wall?.finish ?? room?.finish ?? FINISH_PRESETS.plaster),
                    color: String(d.get("color")),
                    scaleFt: n(d, "scale"),
                    roughness: n(d, "roughness"),
                  })
                }
              >
                <label className="grid gap-1 text-xs">
                  Color
                  <input
                    name="color"
                    type="color"
                    defaultValue={
                      wall?.finish?.color ??
                      room?.finish?.color ??
                      MODEL_MATERIAL_COLORS.plaster
                    }
                    className="h-8 w-full"
                  />
                </label>
                <NumberField
                  name="scale"
                  label="Pattern scale · ft"
                  value={wall?.finish?.scaleFt ?? room?.finish?.scaleFt ?? 2}
                  min={0.1}
                />
                <NumberField
                  name="roughness"
                  label="Roughness"
                  value={
                    wall?.finish?.roughness ?? room?.finish?.roughness ?? 0.7
                  }
                  min={0}
                  max={1}
                />
              </Fields>
            )}
          </>
        )}
        {tab === "furnish" && (
          <>
            <p className="text-xs text-muted-foreground">
              Dimensioned furnishings and architectural fixtures.
            </p>
            <select
              aria-label="Object type"
              className={selectClass}
              value={objectKind}
              onChange={(e) =>
                setObjectKind(e.target.value as BuildingObject["kind"])
              }
            >
              {Object.entries(OBJECT_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.name}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={disabled} onClick={addObject}>
              Add {OBJECT_PRESETS[objectKind].name.toLowerCase()}
            </Button>
            {object && (
              <div
                key={`${object.id}:${model.correctionCount}`}
                className="space-y-3"
              >
                <Fields
                  disabled={disabled}
                  onSubmit={(d) =>
                    onEdit({
                      type: "object.upsert",
                      levelId: level.id,
                      object: {
                        ...object,
                        xFt: n(d, "x"),
                        yFt: n(d, "y"),
                        widthFt: n(d, "width"),
                        depthFt: n(d, "depth"),
                        heightFt: n(d, "height"),
                        rotationDeg: n(d, "rotation"),
                        color: String(d.get("color")),
                      },
                    })
                  }
                >
                  <NumberField name="x" label="X · ft" value={object.xFt} />
                  <NumberField name="y" label="Y · ft" value={object.yFt} />
                  <NumberField
                    name="width"
                    label="Width · ft"
                    value={object.widthFt}
                    min={0.1}
                  />
                  <NumberField
                    name="depth"
                    label="Depth · ft"
                    value={object.depthFt}
                    min={0.1}
                  />
                  <NumberField
                    name="height"
                    label="Height · ft"
                    value={object.heightFt}
                    min={0.1}
                  />
                  <NumberField
                    name="rotation"
                    label="Rotation · degrees"
                    value={object.rotationDeg}
                  />
                  <label className="text-xs">
                    Color
                    <input
                      type="color"
                      name="color"
                      defaultValue={object.color}
                    />
                  </label>
                </Fields>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    onEdit({
                      type: "object.delete",
                      levelId: level.id,
                      objectId: object.id,
                    })
                  }
                >
                  Remove object
                </Button>
              </div>
            )}
          </>
        )}
        {tab === "review" && (
          <>
            {(model.warnings ?? []).map((warning) => (
              <label key={warning} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={
                    model.acknowledgedWarnings?.includes(warning) ?? false
                  }
                  onChange={(event) =>
                    onEdit({
                      type: "source.review",
                      levelId: level.id,
                      warning,
                      acknowledged: event.target.checked,
                    })
                  }
                />
                <span>I reviewed this limitation: {warning}</span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Resolve geometry errors, confirm scale and floor placement, then
              approve this floor.
            </p>
            <div className="space-y-2">
              {issues.map((issue) => (
                <button
                  key={issue.id}
                  onClick={() => {
                    onSelect(issue.objectId ?? null);
                    setTab("structure");
                  }}
                  className={`w-full rounded-md border p-3 text-left text-xs ${issue.severity === "error" ? "border-destructive/40" : "border-border"}`}
                >
                  {issue.message}
                </button>
              ))}
            </div>
            <Fields
              disabled={disabled}
              onSubmit={(d) =>
                onEdit({
                  type: "level.scale",
                  levelId: level.id,
                  feetPerImagePx: n(d, "scale"),
                })
              }
            >
              <NumberField
                name="scale"
                label="Feet per image pixel"
                value={level.source.feetPerImagePx}
                min={0.000001}
              />
            </Fields>
            <Button
              size="sm"
              disabled={
                disabled ||
                issues.some(
                  (i) =>
                    i.severity === "error" || i.id.includes(":reconstruction:"),
                ) ||
                !level.source.scaleConfirmed
              }
              onClick={() =>
                onEdit({
                  type: "level.review",
                  levelId: level.id,
                  reviewed: !level.reviewed,
                })
              }
            >
              {level.reviewed ? "Reopen review" : "Approve floor review"}
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
