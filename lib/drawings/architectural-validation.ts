import {
  pointInPolygon,
  polygonArea,
  wallLengthFt,
  type FloorplanModel,
} from "./floorplan-model";
import { triangulatePolygon } from "./architectural-polygon";
import type { ModelIssue, PlanPoint } from "./architectural-model";

function crosses(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint) {
  const side = (p: PlanPoint, q: PlanPoint, r: PlanPoint) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return (
    side(a, b, c) * side(a, b, d) < -1e-8 &&
    side(c, d, a) * side(c, d, b) < -1e-8
  );
}
export function validArchitecturalRing(ring: PlanPoint[]): boolean {
  if (
    ring.length < 3 ||
    // Validity is geometric, not a minimum usable room size. Source floor
    // voids can be smaller than .01 square feet and must retain their area.
    polygonArea(ring) < 1e-8 ||
    ring.some((p) => p.some((v) => !Number.isFinite(v)))
  )
    return false;
  for (let i = 0; i < ring.length; i++)
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      if (
        crosses(
          ring[i],
          ring[(i + 1) % ring.length],
          ring[j],
          ring[(j + 1) % ring.length],
        )
      )
        return false;
    }
  return true;
}

/** Specific review evidence, never an uncalibrated "accuracy percentage". */
export function validateArchitecturalModel(
  model: FloorplanModel,
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const add = (
    id: string,
    severity: ModelIssue["severity"],
    message: string,
    levelId?: string,
    objectId?: string,
  ) => issues.push({ id, severity, message, levelId, objectId });
  if (!model.levels.length)
    add("no-levels", "error", "Choose at least one floor.");
  for (const level of model.levels) {
    const prefix = level.id,
      id = level.id;
    for (const issue of level.reconstruction?.issues ?? []) {
      if (
        level.reconstruction?.resolutions?.some((r) => r.issueId === issue.id)
      )
        continue;
      // Current geometry supplies these checks below, so manual repairs can
      // clear missing-geometry errors without discarding extraction evidence.
      if (issue.code === "no-walls" || issue.code === "no-spaces") continue;
      add(
        `${prefix}:reconstruction:${issue.id}`,
        issue.severity,
        issue.message,
        id,
        issue.objectId ?? `reconstruction:${issue.id}`,
      );
    }
    if (!level.source.scaleConfirmed)
      add(
        `${prefix}:scale`,
        "review",
        "Confirm this floor’s drawing scale.",
        id,
      );
    if (model.levels.length > 1 && !level.placement?.confirmed)
      add(
        `${prefix}:placement`,
        "review",
        "Align this floor and confirm its elevation.",
        id,
      );
    if (!level.reviewed)
      add(
        `${prefix}:review`,
        "review",
        "Review walls, openings, heights, and room boundaries against the source.",
        id,
      );
    if (!level.walls.length)
      add(
        `${prefix}:walls`,
        "error",
        "This floor has no walls. Trace or generate its layout.",
        id,
      );
    if (!level.rooms.length)
      add(
        `${prefix}:rooms`,
        "error",
        "No enclosed spaces were found. Repair the wall connections.",
        id,
      );
    const ids = new Set<string>();
    for (const item of [
      ...level.walls,
      ...level.openings,
      ...level.rooms,
      ...(level.objects ?? []),
    ]) {
      if (ids.has(item.id))
        add(
          `${prefix}:duplicate:${item.id}`,
          "error",
          "Duplicate object identity.",
          id,
          item.id,
        );
      ids.add(item.id);
    }
    for (const wall of level.walls) {
      if (wallLengthFt(wall) < 0.1)
        add(
          `${prefix}:${wall.id}:length`,
          "error",
          "A wall has zero or negligible length.",
          id,
          wall.id,
        );
    }
    for (const opening of level.openings) {
      const wall = level.walls.find((w) => w.id === opening.wallId);
      if (
        !wall ||
        opening.offsetFt + opening.widthFt > wallLengthFt(wall) + 0.01 ||
        opening.headFt <= opening.sillFt ||
        opening.headFt > (wall.heightFt ?? level.ceilingHeightFt)
      )
        add(
          `${prefix}:${opening.id}:bounds`,
          "error",
          "An opening extends beyond its wall or has invalid heights.",
          id,
          opening.id,
        );
      if (
        level.openings.some(
          (o) =>
            o.id !== opening.id &&
            o.wallId === opening.wallId &&
            o.offsetFt < opening.offsetFt + opening.widthFt &&
            o.offsetFt + o.widthFt > opening.offsetFt,
        )
      )
        add(
          `${prefix}:${opening.id}:overlap`,
          "error",
          "Two openings overlap on this wall.",
          id,
          opening.id,
        );
    }
    for (const room of level.rooms) {
      const holes = room.holes ?? [];
      if (
        !validArchitecturalRing(room.polygon) ||
        holes.some(
          (h) =>
            !validArchitecturalRing(h) ||
            h.some((p) => !pointInPolygon(p, room.polygon)),
        )
      ) {
        add(
          `${prefix}:${room.id}:polygon`,
          "error",
          "A room or floor opening has an invalid boundary.",
          id,
          room.id,
        );
        continue;
      }
      const { points, indices } = triangulatePolygon(room.polygon, holes);
      let area = 0;
      for (let i = 0; i < indices.length; i += 3)
        area += polygonArea(indices.slice(i, i + 3).map((j) => points[j]));
      const expected =
        polygonArea(room.polygon) -
        holes.reduce((s, h) => s + polygonArea(h), 0);
      if (Math.abs(area - expected) > 0.05 || expected <= 0)
        add(
          `${prefix}:${room.id}:mesh`,
          "error",
          "Floor openings overlap or triangulation could not preserve the room area.",
          id,
          room.id,
        );
    }
    if (level.roof && !level.reviewed)
      add(
        `${prefix}:roof`,
        "review",
        "Verify the parametric roof against the roof plan and elevations.",
        id,
        "roof",
      );
  }
  for (const [index, warning] of (model.warnings ?? []).entries())
    if (!model.acknowledgedWarnings?.includes(warning))
      add(`source:${index}`, "review", warning);
  return issues;
}
