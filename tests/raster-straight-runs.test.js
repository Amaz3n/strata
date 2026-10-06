require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { extractRasterEvidence } = require("../lib/drawings/raster-evidence");
const {
  extractRasterStraightRuns,
} = require("../lib/drawings/raster-straight-runs");
const {
  extractRasterPlanEvidence,
} = require("../lib/drawings/raster-plan-evidence");
const {
  rasterWallNetwork,
  vectorWallNetwork,
} = require("../lib/drawings/vector-wall-network");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
const {
  createAreaReplay,
  replayAreaDetection,
} = require("../lib/drawings/area-replay");
function frame(w = 300, h = 240, fpp = 0.02) {
  return {
    pixels: new Uint8Array(w * h).fill(255),
    width: w,
    height: h,
    feetPerPixel: fpp,
    region: { x0: 0.2, y0: 0.3, x1: 0.5, y1: 0.54 },
  };
}
function stroke(input, a, b, thick = 1) {
  const steps = Math.ceil(
    Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])),
  );
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * i) / steps),
      y = Math.round(a[1] + ((b[1] - a[1]) * i) / steps);
    for (let dy = 0; dy < thick; dy++)
      for (let dx = 0; dx < thick; dx++)
        if (
          x + dx >= 0 &&
          x + dx < input.width &&
          y + dy >= 0 &&
          y + dy < input.height
        )
          input.pixels[(y + dy) * input.width + x + dx] = 0;
  }
}
function runs(input, options = {}) {
  return extractRasterStraightRuns({
    ...input,
    contours: extractRasterEvidence(input),
    ...options,
  });
}
function pixel(input, p) {
  return [
    ((p[0] - input.region.x0) / (input.region.x1 - input.region.x0)) *
      input.width,
    ((p[1] - input.region.y0) / (input.region.y1 - input.region.y0)) *
      input.height,
  ];
}
function segments(input, paths) {
  return paths.map((p) => ({
    p,
    a: pixel(input, p.commands[0].slice(1)),
    b: pixel(input, p.commands[1].slice(1)),
  }));
}
test("direct source runs preserve long outlined faces through hatch crossings", () => {
  const input = frame();
  stroke(input, [25, 60], [275, 60], 2);
  stroke(input, [25, 80], [275, 80], 2);
  for (let x = 25; x <= 275; x += 8) stroke(input, [x, 60], [x, 80]);
  const result = runs(input),
    lines = segments(input, result.paths);
  assert.equal(result.limited, false);
  assert.ok(
    lines.some((l) => Math.abs(l.a[1] - 60.5) < 2 && l.b[0] - l.a[0] > 248),
  );
  assert.ok(
    lines.some((l) => Math.abs(l.a[1] - 80.5) < 2 && l.b[0] - l.a[0] > 248),
  );
  assert.ok(
    result.paths.every(
      (p) => p.rasterLine.continuousInk && p.rasterLine.boundaryFraction >= 0.9,
    ),
  );
});
test("positive source gaps stop runs and uncovered tails are not unioned", () => {
  const input = frame();
  stroke(input, [20, 60], [135, 60], 2);
  stroke(input, [141, 60], [280, 60], 2);
  const lines = segments(input, runs(input).paths);
  assert.ok(lines.some((l) => l.a[0] < 25 && l.b[0] >= 134));
  assert.ok(lines.some((l) => l.a[0] <= 143 && l.b[0] > 275));
  assert.ok(!lines.some((l) => l.a[0] < 136 && l.b[0] > 140));
});
test("oblique and slightly rotated source faces remain oblique instead of being snapped to a building grid", () => {
  for (const end of [
    [270, 170],
    [270, 45],
  ]) {
    const input = frame();
    stroke(input, [25, 40], end, 2);
    const lines = segments(input, runs(input).paths),
      longest = lines.sort(
        (a, b) =>
          Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) -
          Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]),
      )[0];
    assert.ok(longest);
    assert.ok(
      Math.hypot(longest.b[0] - longest.a[0], longest.b[1] - longest.a[1]) >
        200,
    );
    const actual = Math.atan2(
        longest.b[1] - longest.a[1],
        longest.b[0] - longest.a[0],
      ),
      expected = Math.atan2(end[1] - 40, end[0] - 25);
    assert.ok(Math.abs(actual - expected) < 0.02);
    assert.ok(longest.p.rasterLine.maximumDeviationPixels <= 1.5);
  }
});
test("solid paint interiors and blank pixels do not manufacture additional straight faces", () => {
  const blank = frame();
  assert.deepEqual(runs(blank).paths, []);
  const input = frame();
  for (let y = 60; y <= 80; y++) stroke(input, [25, y], [275, y]);
  const lines = segments(input, runs(input).paths).filter(
    (l) => Math.abs(l.b[1] - l.a[1]) < 0.1,
  );
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.a[1] <= 63 || l.a[1] >= 78));
});
test("work/path/frame budgets are explicit and preserve incomplete status", () => {
  const input = frame();
  stroke(input, [25, 60], [275, 60], 2);
  assert.equal(runs(input, { maximumWork: 10 }).limited, true);
  assert.equal(runs(input, { maximumPaths: 1 }).limited, true);
  assert.throws(
    () =>
      runs({ ...input, width: 9000, height: 2, pixels: new Uint8Array(18000) }),
    /budget/,
  );
  assert.throws(() => runs(input, { maximumWork: NaN }), /budget/);
});
function roomNetwork(spacing = 8) {
  const input = frame(600, 500, 0.05);
  input.region = { x0: 0, y0: 0, x1: 1, y1: 1 };
  for (const [a, b] of [
    [
      [60, 60],
      [540, 60],
    ],
    [
      [60, 72],
      [540, 72],
    ],
    [
      [60, 428],
      [540, 428],
    ],
    [
      [60, 440],
      [540, 440],
    ],
    [
      [60, 60],
      [60, 440],
    ],
    [
      [72, 60],
      [72, 440],
    ],
    [
      [528, 60],
      [528, 440],
    ],
    [
      [540, 60],
      [540, 440],
    ],
    [
      [400, 200],
      [528, 200],
    ],
    [
      [400, 212],
      [528, 212],
    ],
  ])
    stroke(input, a, b, 2);
  for (let y = 72; y < 428; y += spacing) {
    stroke(input, [60, y], [72, y]);
    stroke(input, [528, y], [540, y]);
  }
  for (let x = 72; x < 528; x += spacing) {
    stroke(input, [x, 60], [x, 72]);
    stroke(input, [x, 428], [x, 440]);
  }
  for (let x = 400; x < 528; x += spacing) stroke(input, [x, 200], [x, 212]);
  return input;
}
test("raster and vector source entry points stay distinct, and raster metadata cannot manufacture a wall", () => {
  const input = roomNetwork(),
    evidence = extractRasterPlanEvidence(input),
    args = {
      evidence,
      sx: 30,
      sy: 25,
      textRuns: [{ text: "BEDROOM", x: 0.3, y: 0.45, w: 0.1, h: 0.03 }],
    };
  assert.equal(vectorWallNetwork(args).bodies.length, 0);
  const network = rasterWallNetwork(args);
  assert.ok(network.bodies.length > 3);
  assert.ok(network.pathIds.size > 5);
  for (const change of [
    (p) => ({ ...p, rasterLine: undefined }),
    (p) => ({
      ...p,
      rasterLine: { ...p.rasterLine, maximumDeviationPixels: 10 },
    }),
    (p) => ({ ...p, rasterLine: { ...p.rasterLine, continuousInk: false } }),
  ])
    assert.equal(
      rasterWallNetwork({
        ...args,
        evidence: { ...evidence, paths: evidence.paths.map(change) },
      }).bodies.length,
      0,
    );
  assert.equal(
    rasterWallNetwork({ ...args, evidence: { ...evidence, truncated: true } })
      .bodies.length,
    0,
  );
});
test("isolated double boxes and unattached parallel bars remain unclassified", () => {
  const input = frame(300, 240, 0.05);
  input.region = { x0: 0, y0: 0, x1: 1, y1: 1 };
  for (const [x0, y0, x1, y1] of [
    [30, 30, 270, 210],
    [40, 40, 260, 200],
  ]) {
    stroke(input, [x0, y0], [x1, y0]);
    stroke(input, [x1, y0], [x1, y1]);
    stroke(input, [x1, y1], [x0, y1]);
    stroke(input, [x0, y1], [x0, y0]);
  }
  for (let x = 40; x <= 260; x += 5) {
    stroke(input, [x, 30], [x, 40]);
    stroke(input, [x, 200], [x, 210]);
  }
  for (let y = 40; y <= 200; y += 5) {
    stroke(input, [30, y], [40, y]);
    stroke(input, [260, y], [270, y]);
  }
  const evidence = extractRasterPlanEvidence(input);
  assert.ok(
    evidence.rasterPairPaint.some((p) => p.pattern === "transverse-ink"),
  );
  assert.equal(
    rasterWallNetwork({
      evidence,
      sx: 15,
      sy: 12,
      textRuns: [{ text: "BEDROOM", x: 0.4, y: 0.4, w: 0.15, h: 0.04 }],
    }).bodies.length,
    0,
  );
});
test("one measured raster wall network supplies shared takeoff, model and deterministic replay with explicit review", async () => {
  const f = roomNetwork(),
    input = {
      segments: [],
      evidence: extractRasterPlanEvidence(f),
      textRuns: [{ text: "BEDROOM", x: 0.3, y: 0.45, w: 0.1, h: 0.03 }],
      imageWidth: 600,
      imageHeight: 500,
      feetPerImagePx: 0.05,
      region: f.region,
      finishPolicy: "include-fixtures",
    };
  const run = await runAreaEngine(input, {
    wholeSheet: true,
    maxRecognitionWindows: 1,
  });
  assert.ok(run.detection.architecture.building.walls.length > 3);
  assert.ok(
    run.detection.architecture.building.issues.some(
      (i) => i.code === "raster-wall-assembly",
    ),
  );
  assert.equal(run.recognition, "unavailable");
  const floor = buildingToFloorplan(
    {
      ...input,
      sheetVersionId: "00000000-0000-4000-8000-000000000001",
      sheetNumber: null,
      sheetTitle: null,
      name: "Raster floor",
      order: 0,
      scaleConfirmed: true,
    },
    run.detection.architecture,
  );
  assert.equal(
    floor.walls.length,
    run.detection.architecture.building.walls.length,
  );
  const replay = await replayAreaDetection(
    createAreaReplay(input, true, {}, run.recognition),
    { compareCurrentEngine: true },
  );
  assert.deepEqual(
    replay.detection.architecture.building.walls,
    run.detection.architecture.building.walls,
  );
});

test("overlapping seed observations contribute once without erasing crossing lines or negative-slope tails", () => {
  const input = frame();
  stroke(input, [180, 20], [90, 215], 2);
  const lines = segments(input, runs(input).paths);
  const diagonal = lines.filter(
    (l) => Math.abs(l.b[0] - l.a[0]) > 20 && Math.abs(l.b[1] - l.a[1]) > 40,
  );
  assert.ok(
    diagonal.some((l) => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) > 210),
  );
  // Different fits may keep short uncovered tails, but may not count the same
  // long observed span twice.
  for (let i = 0; i < diagonal.length; i++)
    for (let j = i + 1; j < diagonal.length; j++) {
      const a = diagonal[i],
        b = diagonal[j],
        len = Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]),
        u = [(a.b[0] - a.a[0]) / len, (a.b[1] - a.a[1]) / len];
      const ts = [b.a, b.b]
        .map((p) => (p[0] - a.a[0]) * u[0] + (p[1] - a.a[1]) * u[1])
        .sort((a, b) => a - b);
      const overlap = Math.min(len, ts[1]) - Math.max(0, ts[0]);
      const distance = (p) =>
        Math.abs((p[0] - a.a[0]) * u[1] - (p[1] - a.a[1]) * u[0]);
      if (Math.max(distance(b.a), distance(b.b)) <= 2)
        assert.ok(overlap < 3, `duplicate measured coverage ${overlap}`);
    }
  const cross = frame();
  stroke(cross, [20, 120], [280, 120], 2);
  stroke(cross, [150, 20], [150, 220], 2);
  const observed = segments(cross, runs(cross).paths);
  assert.ok(
    observed.some(
      (l) => Math.abs(l.a[1] - 120.5) < 2 && l.b[0] - l.a[0] >= 259,
    ),
  );
  assert.ok(
    observed.some(
      (l) => Math.abs(l.a[0] - 150.5) < 2 && l.b[1] - l.a[1] >= 199,
    ),
  );
});

test("close rails separated by white pixels remain distinct even where short hatch crossings connect them", () => {
  const input = frame();
  stroke(input, [25, 80], [275, 80]);
  stroke(input, [25, 83], [275, 83]);
  for (let x = 30; x < 270; x += 10) stroke(input, [x, 80], [x, 83]);
  const lines = segments(input, runs(input).paths);
  for (const y of [80.5, 83.5])
    assert.ok(
      lines.some((l) => Math.abs(l.a[1] - y) < 0.1 && l.b[0] - l.a[0] >= 249),
      `missing rail ${y}`,
    );
  assert.equal(runs(input, { maximumObservationSamples: 50 }).limited, true);
  assert.throws(
    () => runs(input, { maximumObservationSamples: NaN }),
    /budget/,
  );
});

test("long internal faces require layer review instead of an automatically combined wall depth", () => {
  const input = roomNetwork(12);
  stroke(input, [72, 84], [528, 84], 2);
  for (let x = 72; x < 528; x += 12) stroke(input, [x, 72], [x, 84]);
  const evidence = extractRasterPlanEvidence(input),
    network = rasterWallNetwork({
      evidence,
      sx: 30,
      sy: 25,
      textRuns: [{ text: "BEDROOM", x: 0.3, y: 0.45, w: 0.1, h: 0.03 }],
    });
  assert.ok(network.diagnostics.rasterCompositeBands > 0);
  assert.ok(network.diagnostics.rasterCompositePathIds.length >= 3);
  assert.ok(network.bodies.length > 3);
  assert.ok(network.bodies.every((b) => b.thicknessFt < 0.8));
});
