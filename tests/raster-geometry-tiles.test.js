require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  planNativeRasterGeometry,
  mergeNativeRasterGeometry,
  validRasterGeometryTiling,
} = require("../lib/drawings/raster-geometry-tiles");
const {
  RASTER_PAIR_PAINT_PROFILE,
} = require("../lib/drawings/raster-pair-paint");
const region = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 };
const path = (id, points, feature = "linework", extra = {}) => ({
  id,
  kind: "stroke",
  commands: points.map((p, i) => [i ? "L" : "M", ...p]),
  rasterFeature: feature,
  width: 1,
  color: [0],
  colorSpace: "DeviceGray",
  opacity: 1,
  dashes: [],
  clips: [],
  layer: [],
  groups: [],
  evenOdd: false,
  ...extra,
});
function observations() {
  return [0, 1].map((id) => {
    const r = { x0: 0.1 + id * 0.2, y0: 0.1, x1: id ? 0.9 : 0.7, y1: 0.9 },
      evidence = {
        version: 1,
        paths: [
          path(7, [
            [0.4, 0.3],
            [0.6, 0.3],
          ]),
          path(8, [
            [0.4, 0.32],
            [0.6, 0.32],
          ]),
        ],
        truncated: false,
        raster: {
          width: 600,
          height: 800,
          feetPerPixel: 0.02,
          region: r,
          threshold: 120,
          maximumDeviationPixels: 2.5,
        },
        rasterPairPaint: [
          {
            profile: RASTER_PAIR_PAINT_PROFILE,
            pathIds: [7, 8],
            sections: 12,
            fullSections: 12,
            separatedBands: 12,
            inkFraction: 1,
            pattern: "solid-paint",
          },
        ],
      };
    return {
      window: {
        id,
        core: { x0: 0.1 + id * 0.4, y0: 0.1, x1: 0.5 + id * 0.4, y1: 0.9 },
        window: r,
      },
      evidence,
      sha256: (id ? "b" : "a").repeat(64),
      renderDpi: 300,
    };
  });
}
const merge = (o) =>
  mergeNativeRasterGeometry({
    region,
    width: 1000,
    height: 1000,
    feetPerPixel: 0.02,
    observations: o,
    plannedWindows: 2,
  });
test("native cores partition a large view with physical symbol halos, bounded source pixels and no resampling", () => {
  const input = {
    width: 10800,
    height: 7215,
    feetPerPixel: 192 / 10800,
    region,
  };
  const plan = planNativeRasterGeometry(input);
  assert.ok(plan.windows.length > 1 && plan.windows.length <= 32);
  assert.equal(plan.reason, undefined);
  let area = 0;
  for (const w of plan.windows) {
    area += (w.core.x1 - w.core.x0) * (w.core.y1 - w.core.y0);
    assert.ok((w.window.x1 - w.window.x0) * input.width <= 4094.000001);
    assert.ok((w.window.y1 - w.window.y0) * input.height <= 4094.000001);
    assert.ok(w.window.x0 <= w.core.x0 && w.window.x1 >= w.core.x1);
  }
  assert.ok(Math.abs(area - 0.64) < 1e-12);
  const first = plan.windows[0];
  assert.ok(
    (first.window.x1 - first.core.x1) * input.width >= 4.5 / input.feetPerPixel,
  );
  assert.equal(
    planNativeRasterGeometry({ ...input, width: 100000, height: 100000 })
      .windows.length,
    0,
  );
  assert.equal(
    planNativeRasterGeometry({ ...input, feetPerPixel: 0.0001 }).reason,
    "window-budget",
  );
  assert.throws(() => planNativeRasterGeometry({ ...input, width: NaN }));
});
test("duplicate observations retain source windows and paint references without averaging geometry or erasing white-separated rails", () => {
  const source = observations(),
    before = JSON.stringify(source);
  source[1].evidence.paths.push(
    path(9, [
      [0.4, 0.301],
      [0.6, 0.301],
    ]),
  );
  const e = merge(source);
  assert.equal(e.paths.length, 3);
  assert.deepEqual(e.paths[0].rasterWindowIds, [0, 1]);
  assert.deepEqual(e.paths[0].commands, source[0].evidence.paths[0].commands);
  assert.deepEqual(
    e.rasterPairPaint.map((p) => p.pathIds),
    [
      [0, 1],
      [0, 1],
    ],
  );
  assert.equal(e.raster.tiling.status, "complete");
  assert.equal(validRasterGeometryTiling(e.raster.tiling, region), true);
  assert.equal(
    JSON.stringify(source[0]),
    JSON.stringify(JSON.parse(before)[0]),
  );
});
test("artificial crop boundaries are removed without joining disconnected observed contour pieces", () => {
  const source = observations();
  source[0].evidence.paths.push(
    path(10, [
      [0.1, 0.2],
      [0.1, 0.4],
    ]),
  );
  source[0].evidence.paths.push(
    path(
      11,
      [
        [0.12, 0.4],
        [0.1, 0.4],
        [0.1, 0.2],
        [0.12, 0.2],
      ],
      "paint-boundary",
    ),
  );
  const e = merge(source),
    contours = e.paths.filter((p) => p.rasterFeature === "paint-boundary");
  assert.equal(contours.length, 2);
  assert.ok(e.paths.every((p) => p.commands.some((c) => c[1] !== 0.1)));
  assert.ok(contours.every((p) => p.commands.length === 2));
});
test("missing windows and exhausted source budgets remain incomplete and corrupt provenance fails validation", () => {
  const source = observations();
  source[0].evidence.truncated = true;
  assert.equal(merge(source).truncated, true);
  const missing = merge(source.slice(0, 1));
  assert.equal(missing.raster.tiling.status, "partial");
  assert.equal(missing.truncated, true);
  const good = merge(observations()).raster.tiling;
  for (const mutate of [
    (t) => (t.windows[0] = null),
    (t) => (t.windows[0].evidenceSha256 = "fake"),
    (t) => (t.processedWindows = 100),
    (t) => (t.sampledPixels = Infinity),
    (t) => (t.windows[0].region.x0 = 0.2),
    (t) => (t.windows[0].width = 6000),
  ]) {
    const copy = structuredClone(good);
    mutate(copy);
    assert.equal(validRasterGeometryTiling(copy, region), false);
  }
});
