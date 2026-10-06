require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  rasterBoundaryIntervals,
} = require("../lib/drawings/raster-boundary-intervals");
const { extractRasterEvidence } = require("../lib/drawings/raster-evidence");
const {
  extractRasterStraightRuns,
} = require("../lib/drawings/raster-straight-runs");
test("a contaminated continuous face preserves individually qualified intervals at the existing boundary threshold", () => {
  const support = [
    ...Array(126).fill(true),
    ...Array(21).fill(false),
    ...Array(54).fill(true),
  ];
  const r = rasterBoundaryIntervals(support, 12, () => true);
  assert.deepEqual(r, {
    ranges: [
      [0, 126],
      [147, 201],
    ],
    limited: false,
  });
  for (const [start, end] of r.ranges)
    assert.ok(
      support.slice(start, end).filter(Boolean).length / (end - start) >= 0.9,
    );
  assert.deepEqual(
    rasterBoundaryIntervals(
      [...Array(90).fill(true), ...Array(10).fill(false)],
      12,
      () => true,
    ).ranges,
    [[0, 100]],
  );
  assert.deepEqual(
    rasterBoundaryIntervals(Array(200).fill(false), 12, () => true).ranges,
    [],
  );
  assert.deepEqual(
    rasterBoundaryIntervals(
      [...Array(11).fill(true), ...Array(30).fill(false)],
      12,
      () => true,
    ).ranges,
    [],
  );
  assert.equal(rasterBoundaryIntervals(support, 12, () => false).limited, true);
});
test("original pixel crossings preserve short exposed faces without extending across dense paint", () => {
  const width = 300,
    height = 100,
    pixels = new Uint8Array(width * height).fill(255);
  // One continuous face with a dense annotation crossing near its right end.
  for (let x = 20; x <= 280; x++) pixels[50 * width + x] = 0;
  for (let y = 44; y <= 56; y++)
    for (let x = 200; x <= 250; x++) pixels[y * width + x] = 0;
  const input = {
      pixels,
      width,
      height,
      feetPerPixel: 0.02,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    },
    contours = extractRasterEvidence(input);
  const result = extractRasterStraightRuns({ ...input, contours }),
    horizontal = result.paths
      .map((p) => ({
        p,
        a: p.commands[0].slice(1).map((v, i) => v * [width, height][i]),
        b: p.commands[1].slice(1).map((v, i) => v * [width, height][i]),
      }))
      .filter(
        (l) => Math.abs(l.a[1] - 50.5) < 0.1 && Math.abs(l.b[1] - 50.5) < 0.1,
      );
  assert.equal(result.limited, false);
  assert.ok(
    horizontal.some(
      (l) => l.a[0] >= 250 && l.b[0] >= 280 && l.b[0] - l.a[0] < 50,
    ),
  );
  assert.ok(horizontal.every((l) => !(l.a[0] < 200 && l.b[0] > 250)));
  assert.ok(
    result.paths.every(
      (p) => p.rasterLine.boundaryFraction >= 0.9 && p.rasterLine.continuousInk,
    ),
  );
  // Blank source pixels interrupt the long parent; they cannot be interpolated.
  pixels[50 * width + 265] = 255;
  const gap = extractRasterStraightRuns({
    ...input,
    contours: extractRasterEvidence(input),
  });
  assert.ok(
    gap.paths.every((p) => {
      const a = p.commands[0],
        b = p.commands[1];
      return !(
        Math.abs(a[2] * height - 50.5) < 0.1 &&
        Math.abs(b[2] * height - 50.5) < 0.1 &&
        a[1] * width < 265 &&
        b[1] * width > 266
      );
    }),
  );
  assert.equal(
    extractRasterStraightRuns({
      ...input,
      contours,
      maximumObservationSamples: 10,
    }).limited,
    true,
  );
});
