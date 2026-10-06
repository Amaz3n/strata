import type { AreaEvidence, AreaPoint } from "./area-evidence";
import type { VectorWallNetwork } from "./vector-wall-network";
import type { AreaBoundary } from "./area-takeoff";

/** Clip each original measured face to its independently supported wall-body
 * overlap. An inferred body must not promote annotation tails elsewhere on the
 * same source path. Original face orientation and coordinates remain intact. */
export function rasterSourceFaces(
  evidence: AreaEvidence | null | undefined,
  network: Pick<VectorWallNetwork, 'bodies' | 'limited'>,
  sx: number,
  sy: number,
): AreaBoundary[] {
  if (!evidence?.raster || evidence.truncated || network.limited) return [];
  const paths = new Map(evidence.paths.map((p) => [p.id, p])),
    result: AreaBoundary[] = [];
  for (const body of network.bodies)
    for (const id of body.pathIds) {
      const path = paths.get(id);
      if (
        !path ||
        path.commands.length !== 2 ||
        path.commands[0][0] !== "M" ||
        path.commands[1][0] !== "L"
      )
        continue;
      const a: AreaPoint = [path.commands[0][1] * sx, path.commands[0][2] * sy],
        b: AreaPoint = [path.commands[1][1] * sx, path.commands[1][2] * sy],
        v: AreaPoint = [b[0] - a[0], b[1] - a[1]],
        length2 = v[0] ** 2 + v[1] ** 2;
      if (!Number.isFinite(length2) || length2 <= 0) continue;
      const ts = [body.a, body.b]
          .map(
            (p) =>
              ((p[0] * sx - a[0]) * v[0] + (p[1] * sy - a[1]) * v[1]) / length2,
          )
          .sort((a, b) => a - b),
        lo = Math.max(0, ts[0]),
        hi = Math.min(1, ts[1]);
      if (hi <= lo) continue;
      const at = (t: number): AreaPoint => [
        (a[0] + v[0] * t) / sx,
        (a[1] + v[1] * t) / sy,
      ];
      result.push({ a: at(lo), b: at(hi), pathId: id, source: "drawn" });
    }
  return result;
}
