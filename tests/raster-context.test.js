require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  planRasterContext,
  validRasterContext,
  RASTER_CONTEXT_PROFILE,
} = require("../lib/drawings/raster-context");
const { RASTER_ARC_PROFILE } = require("../lib/drawings/raster-arcs");
function fixture(region = { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 }) {
  const commands = Array.from({ length: 8 }, (_, i) => [
    i ? "L" : "M",
    region.x0 + 0.0002 + i * 0.004,
    region.y0 + 0.04 + i * 0.004,
  ]);
  return {
    version: 1,
    truncated: false,
    paths: [
      {
        id: 7,
        kind: "stroke",
        commands,
        width: 0.0002,
        opacity: 1,
        color: [0],
        colorSpace: "DeviceGray",
        dashes: [],
        layer: [],
        groups: [],
        clips: [],
        evenOdd: false,
        rasterFeature: "circular-arc",
        rasterArc: {
          profile: RASTER_ARC_PROFILE,
          sampleCount: 80,
          maximumDeviationPixels: 1,
          sweepRadians: Math.PI / 2,
          continuousInk: true,
          clipped: true,
        },
      },
    ],
    raster: {
      width: 400,
      height: 400,
      feetPerPixel: 0.05,
      threshold: 120,
      maximumDeviationPixels: 2.5,
      region,
    },
  };
}
const plan = (evidence) =>
  planRasterContext({
    evidence,
    imageWidth: 2000,
    imageHeight: 2000,
    feetPerImagePx: 0.05,
  });
test("only measured clipped edge ink requests a bounded halo in the original source frame", () => {
  const e = fixture(),
    before = JSON.stringify(e),
    p = plan(e);
  assert.deepEqual(p.pathIds, [7]);
  assert.deepEqual(p.edges, ["left"]);
  assert.ok(Math.abs(p.region.x0 - 0.1525) < 1e-12);
  assert.equal(p.region.x1, 0.4);
  assert.equal(p.region.y0, 0.2);
  assert.equal(p.region.y1, 0.4);
  assert.equal(JSON.stringify(e), before);
  for (const mutate of [
    (e) => (e.paths[0].rasterArc.clipped = false),
    (e) => (e.paths[0].rasterArc.sampleCount = Infinity),
    (e) => (e.paths[0].rasterArc.sweepRadians = 0),
    (e) => (e.paths[0].rasterArc.continuousInk = false),
    (e) => (e.paths[0].dashes = [1, 1]),
    (e) => (e.truncated = true),
    (e) => (e.paths[0].commands[0][1] = NaN),
    (e) => (e.paths[0].rasterArc.profile = "old"),
    (e) => e.paths[0].commands.forEach((c) => (c[1] += 0.05)),
  ]) {
    const copy = structuredClone(e);
    mutate(copy);
    assert.equal(plan(copy).region, null);
    assert.deepEqual(plan(copy).pathIds, []);
  }
});
test("physical page edges and density/area budgets remain explicit instead of shrinking detail or retrying forever", () => {
  const edge = fixture({ x0: 0, y0: 0.2, x1: 0.2, y1: 0.4 });
  assert.equal(plan(edge).reason, "page-edge");
  const big = fixture();
  big.raster.width = 4096;
  big.paths[0].commands[0][1] = 0.200001;
  assert.equal(plan(big).reason, "geometry-budget");
  const small = fixture({ x0: 0.2, y0: 0.2, x1: 0.21, y1: 0.21 });
  small.raster.feetPerPixel = 0.0025;
  small.paths[0].commands.forEach((c, i) => {
    c[1] = 0.200001 + i * 0.0004;
    c[2] = 0.204 + i * 0.0004;
  });
  assert.equal(plan(small).reason, "geometry-budget");
});
test("cached source context requires matching request and effective frames with bounded provenance", () => {
  const e = fixture(),
    requested = e.raster.region,
    p = plan(e),
    value = {
      profile: RASTER_CONTEXT_PROFILE,
      requestedRegion: requested,
      initialRegion: requested,
      effectiveRegion: p.region,
      initialEvidenceSha256: "a".repeat(64),
      triggerPathIds: p.pathIds,
      edges: p.edges,
      attempts: 1,
      status: "expanded",
    };
  assert.equal(validRasterContext(value, requested, p.region), true);
  for (const mutate of [
    (v) => (v.attempts = 2),
    (v) => (v.initialEvidenceSha256 = "fake"),
    (v) => (v.edges = ["left", "left"]),
    (v) => (v.triggerPathIds = [-1]),
    (v) => (v.requestedRegion = { ...requested, x0: 0.25 }),
    (v) => (v.effectiveRegion = { ...p.region, x0: 0.3 }),
    (v) => (v.reason = "read-failed"),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.equal(validRasterContext(copy, requested, p.region), false);
  }
});
