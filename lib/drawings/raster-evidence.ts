import type { AreaEvidence, AreaPoint, EvidencePath } from "./area-evidence";

/** Pixel-supported contour extraction. No learned coordinates or invented gap
 * closure: every candidate follows a boundary in the supplied grayscale image.
 * Classification and building constraints remain the shared engine's job. */
export const RASTER_EXTRACTION_PROFILE = "raster-contours-3";
export function extractRasterEvidence(input: {
  pixels: Uint8Array;
  width: number;
  height: number;
  feetPerPixel: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  maximumPaths?: number;
}): AreaEvidence {
  const { pixels, width, height, feetPerPixel } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    pixels.length !== width * height ||
    !(feetPerPixel > 0)
  )
    throw new Error("Invalid scan pixels or calibration");
  if (width * height > 25_000_000)
    throw new Error("Scan region exceeds the reconstruction pixel budget");
  const region = input.region ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const maxPaths = input.maximumPaths ?? 12000;
  const threshold = rasterInkThreshold(pixels);
  const ink = (x: number, y: number) =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    pixels[y * width + x] <= threshold;
  // Boundary half-edges keep dark paint on the right. Four bits per pixel
  // record visits; contours may include diagonal stair-steps and internal holes.
  const visited = new Uint8Array(width * height);
  const dx = [1, 0, -1, 0],
    dy = [0, 1, 0, -1];
  const edgePixel = (x: number, y: number, d: number): [number, number] =>
    d === 0
      ? [x, y]
      : d === 1
        ? [x - 1, y]
        : d === 2
          ? [x - 1, y - 1]
          : [x, y - 1];
  const boundary = (x: number, y: number, d: number) => {
    const [rx, ry] = edgePixel(x, y, d),
      [lx, ly] = edgePixel(x + dx[d], y + dy[d], (d + 2) % 4);
    return ink(rx, ry) && !ink(lx, ly);
  };
  const paths: EvidencePath[] = [];
  let truncated = false;
  const emit = (ring: AreaPoint[]) => {
    if (ring.length < 5) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (Math.max(x1 - x0, y1 - y0) * feetPerPixel < 0.75) return;
    const simplified = simplifyContour(ring, 0.8);
    const vertices: AreaPoint[] = [];
    for (let i = 1; i < simplified.length; i++) {
      const a = simplified[i - 1],
        b = simplified[i],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]) * feetPerPixel;
      const pieces = Math.max(1, Math.ceil(length / 12));
      if (!vertices.length) vertices.push(a);
      for (let n = 1; n <= pieces; n++)
        vertices.push([
          a[0] + ((b[0] - a[0]) * n) / pieces,
          a[1] + ((b[1] - a[1]) * n) / pieces,
        ]);
    }
    // Bound both vertex count and physical extent so every source chunk fits
    // a detailed classification crop, even on a large commercial sheet.
    for (let start = 0; start < vertices.length - 1; ) {
      if (paths.length >= maxPaths) {
        truncated = true;
        return;
      }
      let end = start + 1,
        bounds = [
          vertices[start][0],
          vertices[start][1],
          vertices[start][0],
          vertices[start][1],
        ];
      for (; end < vertices.length && end - start <= 40; end++) {
        const p = vertices[end],
          next = [
            Math.min(bounds[0], p[0]),
            Math.min(bounds[1], p[1]),
            Math.max(bounds[2], p[0]),
            Math.max(bounds[3], p[1]),
          ];
        if (
          end > start + 1 &&
          Math.max(next[2] - next[0], next[3] - next[1]) * feetPerPixel > 22
        )
          break;
        bounds = next;
        // Connected ink can join a wall, door leaf and swing in one contour.
        // Split at a supported sharp corner so classification can give those
        // pieces different roles. Keep smooth curve samples together and do
        // not split at the tiny end cap of a one-pixel stroke.
        if (end < vertices.length - 1) {
          const a = vertices[end - 1], b = vertices[end + 1];
          const ux = p[0] - a[0], uy = p[1] - a[1],
            vx = b[0] - p[0], vy = b[1] - p[1];
          const before = Math.hypot(ux, uy), after = Math.hypot(vx, vy);
          if (Math.min(before, after) * feetPerPixel >= .15 &&
              (ux * vx + uy * vy) / (before * after) < Math.cos(Math.PI / 6)) {
            end++;
            break;
          }
        }
      }
      const points = vertices.slice(start, end),
        normalized = points.map(
          ([x, y]): AreaPoint => [
            region.x0 + (x / width) * (region.x1 - region.x0),
            region.y0 + (y / height) * (region.y1 - region.y0),
          ],
        );
      paths.push({
        id: paths.length,
        commands: normalized.map((p, i) => [i ? "L" : "M", p[0], p[1]]),
        kind: "stroke",
        color: [0],
        colorSpace: "DeviceGray",
        opacity: 1,
        width: 1,
        dashes: [],
        layer: [],
        groups: [],
        clips: [],
        evenOdd: false,
      });
      start = end - 1;
    }
  };
  outer: for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!ink(x, y)) continue;
      for (let side = 0; side < 4; side++) {
        if (visited[y * width + x] & (1 << side)) continue;
        const startX = x + (side === 1 || side === 2 ? 1 : 0),
          startY = y + (side === 2 || side === 3 ? 1 : 0);
        if (!boundary(startX, startY, side)) continue;
        let cx = startX,
          cy = startY,
          d = side;
        const ring: AreaPoint[] = [[cx, cy]];
        for (let steps = 0; steps < width * height * 4; steps++) {
          const [px, py] = edgePixel(cx, cy, d);
          if (visited[py * width + px] & (1 << d)) break;
          visited[py * width + px] |= 1 << d;
          cx += dx[d];
          cy += dy[d];
          ring.push([cx, cy]);
          const next = [(d + 1) % 4, d, (d + 3) % 4, (d + 2) % 4].find((n) =>
            boundary(cx, cy, n),
          );
          if (next === undefined) break;
          d = next;
          if (cx === startX && cy === startY && d === side) break;
          if (ring.length > 200_000) {
            truncated = true;
            break;
          }
        }
        emit(ring);
        if (truncated) break outer;
      }
    }
  return {
    version: 1,
    paths,
    truncated,
    unrepresentedPaint: true,
    extractionProfile: RASTER_EXTRACTION_PROFILE,
    raster: {
      width,
      height,
      feetPerPixel,
      threshold,
      maximumDeviationPixels: 0.8,
      region,
    },
  };
}

/** Iterative Ramer–Douglas–Peucker; bounded stack even for noisy scans. */
export function simplifyContour(points: AreaPoint[], tolerance: number): AreaPoint[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!,
      a = points[first],
      b = points[last],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = dx * dx + dy * dy;
    let maximum = tolerance * tolerance,
      index = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i],
        t = length
          ? Math.max(
              0,
              Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length),
            )
          : 0;
      const distance =
        (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (distance > maximum) {
        maximum = distance;
        index = i;
      }
    }
    if (index < 0) continue;
    keep[index] = 1;
    stack.push([first, index], [index, last]);
  }
  return points.filter((_, i) => keep[i]);
}

/** Shared threshold keeps contour and stroke experiments on identical ink. */
export function rasterInkThreshold(pixels: Uint8Array): number {
  const histogram = new Uint32Array(256);
  for (const p of pixels) histogram[p]++;
  let total = 0,
    sum = 0,
    threshold = 160,
    best = 0,
    count = 0;
  for (let i = 0; i < 256; i++) total += i * histogram[i];
  for (let i = 0; i < 255; i++) {
    count += histogram[i];
    sum += i * histogram[i];
    if (!count || count === pixels.length) continue;
    const between =
      count *
      (pixels.length - count) *
      (sum / count - (total - sum) / (pixels.length - count)) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  threshold = Math.max(40, Math.min(210, threshold));
  return threshold;
}
