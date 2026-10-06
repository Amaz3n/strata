"use client";

import { AlertTriangle, Check } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { FINISH_PRESETS, OBJECT_PRESETS, type BuildingObject } from "@/lib/drawings/architectural-model";
import { DESIGN_PALETTES, paletteEdits, type DesignPalette } from "@/lib/drawings/design-palettes";
import type { FloorplanEdit, FloorplanModel } from "@/lib/drawings/floorplan-model";
import { FURNITURE_CATALOG, FURNITURE_CATEGORY_LABELS, type FurnitureCategory } from "@/lib/drawings/furniture-catalog";
import { clearanceIssues } from "@/lib/drawings/furniture-layout";
import { formatQuantity } from "@/lib/drawings/measure";
import type { SurfaceTakeoffMap } from "@/lib/drawings/model-takeoff";
import type { ConditionRollup } from "@/lib/services/takeoff";
import { cn } from "@/lib/utils";

import type { ModelPick } from "@/components/plans/model-viewer/model-viewer";
import { FLOOR_FINISHES } from "./model-pane";
import type { ModelExtras } from "./use-model-extras";

/** Something about to be dropped on the floor: a real catalogue piece or a built-in fixture. */
export interface PlacingPiece {
  kind: BuildingObject["kind"];
  modelId?: string;
  name: string;
  widthFt: number;
  depthFt: number;
  heightFt: number;
  againstWall: boolean;
}

/** Built-ins the catalogue has no real model for; they draw as simple shapes. */
const FIXTURES: Array<BuildingObject["kind"]> = ["bed", "counter"];

const CATEGORIES = Object.keys(FURNITURE_CATEGORY_LABELS) as FurnitureCategory[];

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/**
 * Designing on the model: a palette for the whole house, each room's floor
 * and what the takeoff counts it as, Design Studio options shown in the model
 * and priced off it, and real furniture to read a room's scale — with the
 * layout checked as it goes. Finishes and furniture are saved onto the model;
 * options are only shown, never saved, because choosing them is the buyer's.
 */
export function DesignPanel({
  model,
  focus,
  takeoff,
  rollups,
  selected,
  canWrite,
  placing,
  extras,
  onSelectRoom,
  onSelectObject,
  onStartPlacing,
  onApplyEdits,
}: {
  model: FloorplanModel | null;
  focus: string;
  takeoff: Record<string, SurfaceTakeoffMap>;
  rollups: ConditionRollup[] | null;
  selected: ModelPick | null;
  canWrite: boolean;
  placing: PlacingPiece | null;
  extras: ModelExtras;
  onSelectRoom: (levelId: string, roomId: string) => void;
  onSelectObject: (levelId: string, objectId: string) => void;
  onStartPlacing: (piece: PlacingPiece | null) => void;
  onApplyEdits: (edits: FloorplanEdit[], label: string) => void;
}) {
  if (!model) {
    return (
      <div className="px-4 py-8 text-sm text-muted-foreground">
        Finishes and furniture are set on the 3D model. Build the model from the 3D view first.
      </div>
    );
  }
  const levels = [...model.levels].sort((a, b) => a.order - b.order).filter((level) => focus === "all" || level.id === focus);
  const conditionName = (id: string | undefined) => (id ? rollups?.find((row) => row.condition.id === id)?.condition.name : undefined);
  const objectCount = model.levels.reduce((sum, level) => sum + (level.objects?.length ?? 0), 0);
  const issues = levels.flatMap((level) =>
    clearanceIssues(level).map((issue) => ({ ...issue, levelId: level.id, name: level.objects?.find((object) => object.id === issue.objectId)?.name ?? "Piece" })),
  );
  const applyPalette = (palette: DesignPalette) => {
    const edits = paletteEdits({ levels }, palette);
    if (edits.length > 0) onApplyEdits(edits, `${palette.name} on ${edits.length} ${edits.length === 1 ? "room" : "rooms"}`);
  };
  const selectedTotal = extras.pricedOptions.filter(({ option }) => extras.activeOptionIds.has(option.id)).reduce((sum, { price }) => sum + price.totalCents, 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4">
      <section aria-label="Palettes">
        <div className="px-4 pb-2 pt-4">
          <span className="microlabel">Palette</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 px-4">
          {DESIGN_PALETTES.map((palette) => (
            <button
              key={palette.id}
              type="button"
              disabled={!canWrite}
              onClick={() => applyPalette(palette)}
              className="grid gap-1.5 border bg-card p-2 text-left transition-colors hover:border-line-strong disabled:opacity-50"
            >
              <span className="flex h-4" aria-hidden>
                {palette.changes.map((change) => (
                  <span key={`${change.finish}-${change.rooms.join()}`} className="flex-1 border-r border-background last:border-r-0" style={{ backgroundColor: FINISH_PRESETS[change.finish]?.color }} />
                ))}
              </span>
              <span className="text-xs font-medium leading-tight">{palette.name}</span>
            </button>
          ))}
        </div>
        <p className="px-4 pt-1.5 text-[11px] text-muted-foreground">Sets every floor on {focus === "all" ? "the house" : "this floor"}; baths and bedrooms get their own.</p>
      </section>

      {levels.map((level) => {
        const finished = level.rooms.filter((room) => takeoff[level.id]?.[room.id]).length;
        return (
          <section key={level.id} aria-label={`${level.name} finishes`}>
            <div className="flex items-baseline justify-between px-4 pb-1 pt-5">
              <span className="microlabel">{level.name} · floor finishes</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {finished}/{level.rooms.length} in takeoff
              </span>
            </div>
            {level.rooms.length === 0 ? (
              <p className="px-4 py-1.5 text-xs text-muted-foreground">No rooms were traced on this floor.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {level.rooms.map((room) => {
                    const look = Object.entries(FINISH_PRESETS).find(([, finish]) => finish.color === room.finish?.color && finish.pattern === room.finish?.pattern)?.[0];
                    const lookLabel = FLOOR_FINISHES.find((option) => option.key === look)?.label;
                    const counted = conditionName(takeoff[level.id]?.[room.id]?.conditionId);
                    const active = selected?.kind === "room" && selected.id === room.id;
                    return (
                      <tr key={room.id} className={cn("cursor-pointer border-t", active ? "bg-accent" : "hover:bg-muted/60")} onClick={() => onSelectRoom(level.id, room.id)}>
                        <td className="py-2 pl-4 pr-2">
                          <div className="truncate font-medium">{room.label ?? "Room"}</div>
                          <div className={cn("truncate text-xs", counted ? "text-muted-foreground" : "text-warning")}>{counted ?? "Not in the takeoff"}</div>
                        </td>
                        <td className="py-2 pr-2">
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="size-3 shrink-0 border" style={{ backgroundColor: room.finish?.color }} aria-hidden />
                            {lookLabel ?? (room.finish ? "Custom" : "—")}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatQuantity(room.areaSqft)} SF</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {extras.options !== null && (
        <section aria-label="Options">
          <div className="flex items-baseline justify-between px-4 pb-1 pt-5">
            <span className="microlabel">Options in the model</span>
            {selectedTotal > 0 && <span className="font-mono text-[11px] tabular-nums">{money(selectedTotal)} shown</span>}
          </div>
          {extras.options.length === 0 ? (
            <p className="px-4 py-1.5 text-xs text-muted-foreground">
              No Design Studio options change the model yet. Give an option a floor, wall or furniture change in the catalog and it appears here, priced off this house.
            </p>
          ) : (
            <ul>
              {extras.pricedOptions.map(({ option, price }) => {
                const on = extras.activeOptionIds.has(option.id);
                const basis = price.lines.map((line) => (line.uom === "sf" ? `${formatQuantity(line.quantity)} SF` : `${line.quantity} ea`)).join(" + ");
                return (
                  <li key={option.id} className="border-t">
                    <label className={cn("flex cursor-pointer items-start gap-2.5 px-4 py-2", on ? "bg-accent" : "hover:bg-muted/60")}>
                      <Checkbox checked={on} onCheckedChange={() => extras.toggleOption(option.id)} className="mt-0.5" aria-label={`Show ${option.name}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{option.name}</span>
                        <span className={cn("block truncate text-xs", price.lines.every((line) => line.quantity === 0) ? "text-warning" : "text-muted-foreground")}>
                          {price.lines.every((line) => line.quantity === 0) ? "No matching rooms in this house" : basis}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">{money(price.totalCents)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {extras.optionsTruncated && <p className="px-4 pt-1 text-[11px] text-muted-foreground">Showing the first 200 options.</p>}
        </section>
      )}

      <section aria-label="Furnish">
        <div className="flex items-baseline justify-between px-4 pb-2 pt-5">
          <span className="microlabel">Furnish</span>
          <span className="font-mono text-[11px] text-muted-foreground">{objectCount} placed</span>
        </div>
        {CATEGORIES.map((category) => {
          const pieces = FURNITURE_CATALOG.filter((piece) => piece.category === category);
          return (
            <div key={category} className="px-4 pb-2">
              <div className="pb-1 text-[11px] font-medium text-muted-foreground">{FURNITURE_CATEGORY_LABELS[category]}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {pieces.map((piece) => {
                  const on = placing?.modelId === piece.id;
                  return (
                    <PieceButton
                      key={piece.id}
                      on={on}
                      disabled={!canWrite}
                      name={piece.name}
                      size={`${formatFeet(piece.widthFt)} × ${formatFeet(piece.depthFt)}`}
                      onClick={() =>
                        onStartPlacing(
                          on
                            ? null
                            : { kind: piece.kind, modelId: piece.id, name: piece.name, widthFt: piece.widthFt, depthFt: piece.depthFt, heightFt: piece.heightFt, againstWall: piece.againstWall },
                        )
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="px-4 pb-2">
          <div className="pb-1 text-[11px] font-medium text-muted-foreground">Fixtures</div>
          <div className="grid grid-cols-2 gap-1.5">
            {FIXTURES.map((kind) => {
              const preset = OBJECT_PRESETS[kind];
              const on = placing?.kind === kind && !placing.modelId;
              return (
                <PieceButton
                  key={kind}
                  on={on}
                  disabled={!canWrite}
                  name={preset.name}
                  size={`${formatFeet(preset.widthFt)} × ${formatFeet(preset.depthFt)}`}
                  onClick={() => onStartPlacing(on ? null : { kind, name: preset.name, widthFt: preset.widthFt, depthFt: preset.depthFt, heightFt: preset.heightFt, againstWall: kind === "bed" })}
                />
              );
            })}
          </div>
        </div>
        <p className="px-4 pt-1 text-[11px] text-muted-foreground">Furniture models: Poly Haven (CC0).</p>
        {!canWrite && <p className="px-4 pt-2 text-xs text-muted-foreground">You can look, but placing furniture needs edit access to plans.</p>}
      </section>

      {objectCount > 0 && (
        <section aria-label="Layout check">
          <div className="flex items-baseline justify-between px-4 pb-1 pt-5">
            <span className="microlabel">Layout check</span>
            <span className={cn("font-mono text-[11px]", issues.length ? "text-warning" : "text-success")}>{issues.length ? `${issues.length} to look at` : "All clear"}</span>
          </div>
          {issues.length === 0 ? (
            <p className="flex items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground">
              <Check className="size-3 text-success" />
              Nothing overlaps, blocks a door, or runs into a wall.
            </p>
          ) : (
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.objectId}:${issue.code}:${issue.otherId ?? ""}`} className="border-t">
                  <button type="button" onClick={() => onSelectObject(issue.levelId, issue.objectId)} className="flex w-full items-start gap-2 px-4 py-2 text-left text-xs hover:bg-muted/60">
                    <AlertTriangle className="mt-px size-3 shrink-0 text-warning" />
                    {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function PieceButton({ on, disabled, name, size, onClick }: { on: boolean; disabled: boolean; name: string; size: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={on}
      className={cn("grid gap-0.5 border bg-card px-2.5 py-2 text-left transition-colors hover:border-line-strong disabled:opacity-50", on && "border-foreground bg-accent")}
    >
      <span className="truncate text-sm font-medium">{name}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{size}</span>
    </button>
  );
}

function formatFeet(feet: number): string {
  const total = Math.round(feet * 12);
  return `${Math.floor(total / 12)}'${total % 12 ? `${total % 12}"` : ""}`;
}
