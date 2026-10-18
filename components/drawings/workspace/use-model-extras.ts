"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadModelOptionsAction } from "@/app/(app)/design-studio/actions";
import { loadFloorplanRevisionModelAction, loadFloorplanRevisionsAction } from "@/app/(app)/floorplan/actions";
import type { ModelPin, ModelSceneDiff } from "@/components/plans/model-viewer/model-viewer";
import { normalizedToModel, type FloorplanModel, type Level } from "@/lib/drawings/floorplan-model";
import { diffLevel, estimateDelta, type EstimateDelta, type LevelDiff } from "@/lib/drawings/model-diff";
import { applyModelOptions, priceModelOption, type ModelOption } from "@/lib/drawings/model-options";
import type { SurfaceTakeoffMap } from "@/lib/drawings/model-takeoff";
import type { DrawingPin } from "@/lib/services/drawing-markups";
import type { FloorplanTarget } from "@/lib/services/floorplan-models";
import type { ConditionRollup } from "@/lib/services/takeoff";

/**
 * The parts of the 3D view that come from outside the model itself:
 *
 * - **Options** from the Design Studio catalogue that change the house. Turning
 *   one on shows it in the model (never saved onto it) and prices it from the
 *   model's own quantities.
 * - **Compare** against any earlier saved revision of the model: what was
 *   added, removed and resized, and what that does to the estimate.
 * - **Pins**: the issues and photos on the sheet on screen, standing in 3D.
 */
export function useModelExtras({
  model,
  target,
  projectId,
  enabled,
  takeoff,
  rollups,
  pins,
  sheetLevel,
}: {
  model: FloorplanModel | null;
  target: FloorplanTarget | null;
  /** Options are sold per project; a plan-only model has none. */
  projectId: string | null;
  enabled: boolean;
  takeoff: Record<string, SurfaceTakeoffMap>;
  rollups: ConditionRollup[] | null;
  pins: DrawingPin[];
  sheetLevel: Level | null;
}) {
  const [options, setOptions] = useState<{ list: ModelOption[]; truncated: boolean } | null>(null);
  const [activeOptionIds, setActiveOptionIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!enabled || !projectId) return;
    let live = true;
    void loadModelOptionsAction(projectId).then((result) => {
      if (!live) return;
      setOptions(result.success ? { list: result.data.options, truncated: result.data.truncated } : { list: [], truncated: false });
    });
    return () => {
      live = false;
    };
  }, [enabled, projectId]);

  const activeOptions = useMemo(() => (options?.list ?? []).filter((option) => activeOptionIds.has(option.id)), [options, activeOptionIds]);
  const displayModel = useMemo(() => (model && activeOptions.length > 0 ? applyModelOptions(model, activeOptions) : model), [model, activeOptions]);
  const pricedOptions = useMemo(
    () => (model ? (options?.list ?? []).map((option) => ({ option, price: priceModelOption(model, option) })) : []),
    [model, options],
  );
  const toggleOption = useCallback((id: string) => {
    setActiveOptionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- Compare --------------------------------------------------------------
  const [revisions, setRevisions] = useState<Array<{ id: string; saved_at: string }> | null>(null);
  const [comparing, setComparing] = useState<{ revisionId: string; savedAt: string; model: FloorplanModel } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    if (!target) return;
    const result = await loadFloorplanRevisionsAction(target);
    setRevisions(result.success ? result.data : []);
  }, [target]);

  const compareWith = useCallback(
    async (revision: { id: string; saved_at: string } | null) => {
      setCompareError(null);
      if (!revision || !target) {
        setComparing(null);
        return;
      }
      const result = await loadFloorplanRevisionModelAction(target, revision.id);
      if (!result.success || !result.data) {
        setCompareError(result.success ? "That revision can't be read any more." : result.error);
        return;
      }
      setComparing({ revisionId: revision.id, savedAt: revision.saved_at, model: result.data });
    },
    [target],
  );

  const comparison = useMemo(() => {
    if (!comparing || !model) return null;
    const levels: Array<{ levelId: string; name: string; diff: LevelDiff }> = [];
    for (const level of model.levels) {
      // Same floor: same id, or the same source sheet after a rebuild renamed it.
      const before =
        comparing.model.levels.find((candidate) => candidate.id === level.id) ??
        comparing.model.levels.find((candidate) => candidate.source.sheetNumber === level.source.sheetNumber && candidate.order === level.order);
      levels.push({ levelId: level.id, name: level.name, diff: diffLevel(before ?? { rooms: [], walls: [] }, level) });
    }
    const countedBy = new Map<string, string[]>();
    for (const map of Object.values(takeoff)) {
      for (const [surfaceId, entry] of Object.entries(map)) countedBy.set(surfaceId, [...(countedBy.get(surfaceId) ?? []), entry.conditionId]);
    }
    const conditions = (rollups ?? []).map((row) => ({
      conditionId: row.condition.id,
      name: row.condition.name,
      uom: row.condition.uom,
      wastePct: row.condition.waste_pct,
      unitCostCents: row.effective_unit_cost_cents,
    }));
    const merged: LevelDiff = { rooms: levels.flatMap((level) => level.diff.rooms), addedWalls: [], removedWalls: [] };
    const delta: EstimateDelta = estimateDelta(merged, countedBy, conditions);
    const scene: ModelSceneDiff[] = levels.map(({ levelId, diff }) => ({
      levelId,
      addedWallIds: diff.addedWalls.map((wall) => wall.id),
      removedWalls: diff.removedWalls,
      rooms: diff.rooms.flatMap((room) => (room.status === "removed" ? [] : [{ roomId: room.roomId, status: room.status }])),
      removedRooms: diff.rooms.filter((room) => room.status === "removed").map((room) => room.polygon),
    }));
    const count = (status: string) => merged.rooms.filter((room) => room.status === status).length;
    return {
      savedAt: comparing.savedAt,
      revisionId: comparing.revisionId,
      scene,
      delta,
      summary: {
        roomsAdded: count("added"),
        roomsRemoved: count("removed"),
        roomsChanged: count("changed"),
        wallsAdded: levels.reduce((sum, level) => sum + level.diff.addedWalls.length, 0),
        wallsRemoved: levels.reduce((sum, level) => sum + level.diff.removedWalls.length, 0),
      },
    };
  }, [comparing, model, takeoff, rollups]);

  // --- Pins -------------------------------------------------------------------
  const modelPins = useMemo<ModelPin[]>(() => {
    if (!sheetLevel) return [];
    return pins.map((pin) => {
      const point = normalizedToModel(sheetLevel.source, pin.x_position, pin.y_position);
      const status = pin.status ?? "open";
      return {
        id: pin.id,
        levelId: sheetLevel.id,
        xFt: point.x,
        yFt: point.y,
        tone: status === "closed" || status === "approved" ? "success" : status === "rejected" ? "danger" : pin.entity_type === "photo" ? "accent" : "warning",
        glyph: PIN_GLYPHS[pin.entity_type] ?? "•",
      };
    });
  }, [pins, sheetLevel]);

  return {
    options: options?.list ?? null,
    optionsTruncated: options?.truncated ?? false,
    pricedOptions,
    activeOptionIds,
    toggleOption,
    displayModel,
    revisions,
    loadRevisions,
    compareWith,
    comparison,
    compareError,
    modelPins,
  };
}

const PIN_GLYPHS: Record<string, string> = {
  rfi: "?",
  punch_list: "!",
  task: "✓",
  photo: "◉",
  submittal: "S",
  daily_log: "D",
  observation: "O",
};

export type ModelExtras = ReturnType<typeof useModelExtras>;
