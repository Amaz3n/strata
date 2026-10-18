"use client";

import { useEffect, useMemo, useState } from "react";

import { listDrawingMarkupsAction } from "@/app/(app)/drawings/actions";
import type { DrawingMarkup } from "@/app/(app)/drawings/types";
import type { FloorplanModel } from "@/lib/drawings/floorplan-model";
import { matchLevelTakeoff, type SurfaceTakeoffMap, type TakeoffMarkupShape } from "@/lib/drawings/model-takeoff";
import type { ConditionRollup } from "@/lib/services/takeoff";

const toShape = (markup: DrawingMarkup): TakeoffMarkupShape => ({
  id: markup.id,
  type: markup.data.type,
  points: markup.data.points,
  conditionId: markup.condition_id,
  deduction: markup.data.style?.deduction === true,
});

/**
 * Which walls and rooms of the model the takeoff already counts.
 *
 * The sheet on screen supplies its own measurements live, so a room filled on
 * the sheet turns colour in 3D the moment it saves; the model's other source
 * sheets are read once (measuring markups only) and re-read on refresh.
 */
export function useModelTakeoff({
  model,
  enabled,
  rollups,
  activeMarkups,
  refreshToken,
}: {
  model: FloorplanModel | null;
  enabled: boolean;
  rollups: ConditionRollup[] | null;
  activeMarkups: DrawingMarkup[];
  refreshToken: number;
}) {
  const [remote, setRemote] = useState<Record<string, DrawingMarkup[]>>({});
  const activeKey = [...new Set(activeMarkups.map((markup) => markup.sheet_version_id).filter(Boolean))].sort().join(",");
  const activeVersions = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const versionIds = useMemo(() => [...new Set((model?.levels ?? []).map((level) => level.source.sheetVersionId))], [model]);

  useEffect(() => {
    if (!enabled || versionIds.length === 0) return;
    let cancelled = false;
    const missing = versionIds.filter((id) => !activeVersions.has(id));
    Promise.all(
      missing.map((id) =>
        listDrawingMarkupsAction({ sheet_version_id: id, measuring_only: true, limit: 500 })
          .then((markups) => [id, markups] as const)
          .catch(() => [id, [] as DrawingMarkup[]] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setRemote(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, versionIds, activeVersions, refreshToken]);

  return useMemo(() => {
    const byLevel: Record<string, SurfaceTakeoffMap> = {};
    const colors: Record<string, string> = {};
    const byCondition = new Map<string, string[]>();
    if (!model || !rollups) return { byLevel, colors, byCondition };
    const conditions = rollups.map((row) => ({ id: row.condition.id, color: row.condition.color, heightFt: row.condition.height_ft }));
    for (const level of model.levels) {
      const version = level.source.sheetVersionId;
      const markups = activeVersions.has(version)
        ? activeMarkups.filter((markup) => markup.sheet_version_id === version)
        : (remote[version] ?? []);
      const map = matchLevelTakeoff(level, markups.map(toShape), conditions);
      byLevel[level.id] = map;
      for (const [surfaceId, entry] of Object.entries(map)) {
        colors[surfaceId] = entry.color;
        byCondition.set(entry.conditionId, [...(byCondition.get(entry.conditionId) ?? []), surfaceId]);
      }
    }
    return { byLevel, colors, byCondition };
  }, [model, rollups, activeMarkups, activeVersions, remote]);
}
