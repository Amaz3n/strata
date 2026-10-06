require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { measureRasterPairPaint } = require("../lib/drawings/raster-pair-paint");
function fixture() {
  const width = 160,
    height = 300,
    pixels = new Uint8Array(width * height).fill(255),
    support = {
      profile: "pixel-supported-straight-3",
      sampleCount: 241,
      boundaryFraction: 1,
      maximumDeviationPixels: 0,
      continuousInk: true,
    };
  return {
    width,
    height,
    pixels,
    feetPerPixel: 0.02,
    threshold: 40,
    region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    paths: [30, 50].map((x, id) => ({
      id,
      kind: "stroke",
      rasterLine: support,
      commands: [
        ["M", (x + 0.5) / width, 30.5 / height],
        ["L", (x + 0.5) / width, 270.5 / height],
      ],
    })),
  };
}
function horizontal(f, y) {
  for (let x = 30; x <= 50; x++) f.pixels[y * f.width + x] = 0;
}
test("repeated transverse ink and solid paint are measured source cues", () => {
  const hatch = fixture();
  for (let y = 40; y < 265; y += 10) horizontal(hatch, y);
  const a = measureRasterPairPaint(hatch).pairs[0];
  assert.equal(a.pattern, "transverse-ink");
  assert.ok(a.separatedBands >= 20);
  assert.ok(a.inkFraction >= 0.08);
  const filled = fixture();
  for (let y = 30; y <= 270; y++) horizontal(filled, y);
  const b = measureRasterPairPaint(filled).pairs[0];
  assert.equal(b.pattern, "solid-paint");
  assert.equal(b.inkFraction, 1);
});
test("parallel rails, end caps and isolated dimension ticks do not corroborate a wall interior", () => {
  for (const mode of ["rails", "caps", "ticks"]) {
    const f = fixture();
    if (mode === "rails")
      for (const x of [30, 34, 42, 50])
        for (let y = 30; y <= 270; y++) f.pixels[y * f.width + x] = 0;
    if (mode === "caps") {
      horizontal(f, 30);
      horizontal(f, 270);
    }
    if (mode === "ticks") for (const y of [60, 120, 180]) horizontal(f, y);
    const p = measureRasterPairPaint(f).pairs[0];
    assert.equal(p.pattern, "unresolved");
  }
});
test("empty strips and light paint remain unresolved at the measured source threshold", () => {
  const f = fixture();
  assert.equal(measureRasterPairPaint(f).pairs[0].pattern, "unresolved");
  for (let y = 30; y <= 270; y++)
    for (let x = 30; x <= 50; x++) f.pixels[y * f.width + x] = 200;
  assert.equal(measureRasterPairPaint(f).pairs[0].pattern, "unresolved");
});
test("exhausted pair-paint sampling is explicitly partial instead of positive evidence", () => {
  const f = fixture();
  for (let y = 30; y <= 270; y++) horizontal(f, y);
  const result = measureRasterPairPaint({ ...f, maximumWork: 1 });
  assert.equal(result.limited, true);
  assert.deepEqual(result.pairs, []);
  assert.throws(
    () => measureRasterPairPaint({ ...f, threshold: NaN }),
    /budget/,
  );
});

test("parallel raster fits use bounded measured residuals, while diverging or malformed fits remain unsupported", () => {
  const f = fixture();
  for (let y = 40; y < 265; y += 10) horizontal(f, y);
  f.paths[1].rasterLine = {
    ...f.paths[1].rasterLine,
    maximumDeviationPixels: 1,
  };
  f.paths[1].commands[1][1] += 1 / f.width;
  assert.equal(measureRasterPairPaint(f).pairs[0].pattern, "transverse-ink");
  f.paths[1].commands[1][1] += 4 / f.width;
  assert.deepEqual(measureRasterPairPaint(f).pairs, []);
  for (const error of [NaN, Infinity, 10]) {
    const invalid = fixture();
    invalid.paths[0].rasterLine = {
      ...invalid.paths[0].rasterLine,
      maximumDeviationPixels: error,
    };
    assert.deepEqual(measureRasterPairPaint(invalid).pairs, []);
  }
});

test("bounded source separation intervals retain paint and divergence checks", () => {
  const f = fixture();
  f.paths[1].rasterLine = {
    ...f.paths[1].rasterLine,
    maximumDeviationPixels: 1,
  };
  f.paths[1].commands[1][1] += 3 / f.width;
  for (let y = 40; y < 265; y += 10)
    for (let x = 30; x <= Math.ceil(50 + (3 * (y - 30)) / 240); x++)
      f.pixels[y * f.width + x] = 0;
  const result = measureRasterPairPaint(f);
  assert.equal(result.limited, false);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].profile, "measured-pair-paint-4");
  assert.equal(result.pairs[0].pattern, "transverse-ink");
  assert.ok(
    Math.abs(
      Math.abs(
        result.pairs[0].normalDepthPixels[1] -
          result.pairs[0].normalDepthPixels[0],
      ) - 3,
    ) < 1e-6,
  );
  const empty = { ...f, pixels: new Uint8Array(f.width * f.height).fill(255) };
  assert.equal(measureRasterPairPaint(empty).pairs[0].pattern, "unresolved");
  f.paths[1].commands[1][1] += 3 / f.width;
  assert.equal(measureRasterPairPaint(f).pairs.length, 0);
});

test("remote endpoints outside the shared source interval do not remove locally supported paint", () => {
  const f = fixture();
  f.paths[0].commands = [
    ["M", 30.5 / f.width, 190.5 / f.height],
    ["L", 30.5 / f.width, 270.5 / f.height],
  ];
  f.paths[1].commands = [
    ["M", 48.5 / f.width, 30.5 / f.height],
    ["L", 51.5 / f.width, 270.5 / f.height],
  ];
  f.paths[1].rasterLine = {
    ...f.paths[1].rasterLine,
    maximumDeviationPixels: 0,
  };
  for (let y = 195; y < 268; y += 5)
    for (let x = 30; x <= Math.ceil(48 + (3 * (y - 30)) / 240); x++)
      f.pixels[y * f.width + x] = 0;
  const p = measureRasterPairPaint(f).pairs[0];
  assert.ok(p);
  assert.equal(p.pattern, "transverse-ink");
  assert.ok(
    Math.abs(Math.abs(p.normalDepthPixels[1] - p.normalDepthPixels[0]) - 1) <
      1e-6,
  );
  assert.ok(p.sections < 90);
});
