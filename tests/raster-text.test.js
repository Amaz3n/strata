require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  RASTER_TEXT_PROFILE,
  rasterTextWindows,
  rasterTextRuns,
  mergeArchitecturalTextRuns,
  authoritativeDimensionText,
  validRasterTextEvidence,
} = require("../lib/drawings/raster-text");
const { encodeTextRuns, parseTextRuns } = require("../lib/drawings/text-runs");
const { areaTextRuns, areaRoomLabel } = require("../lib/drawings/area-labels");
const { filterAreaDimensions } = require("../lib/drawings/area-dimensions");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const {
  createAreaReplay,
  replayAreaDetection,
} = require("../lib/drawings/area-replay");
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
const full = { x0: 0, y0: 0, x1: 1, y1: 1 };
const ocr = { profile: RASTER_TEXT_PROFILE, confidence: 88 };
const run = (text, x = 0.3, y = 0.3) => ({ text, x, y, w: 0.1, h: 0.02, ocr });

test("native scan windows cover source edges with bounded, overlapping detail", () => {
  const windows = rasterTextWindows(10800, 7215, full);
  assert.equal(windows.length, 24);
  assert.deepEqual(windows[0], {
    x0: 0,
    y0: 0,
    x1: 2048 / 10800,
    y1: 2048 / 7215,
  });
  assert.equal(windows.at(-1).x1, 1);
  assert.equal(windows.at(-1).y1, 1);
  assert.equal(windows[1].x0, 1952 / 10800);
  assert.ok(
    windows.every(
      (w) =>
        (w.x1 - w.x0) * 10800 <= 2048.000001 &&
        (w.y1 - w.y0) * 7215 <= 2048.000001,
    ),
  );
  assert.throws(() => rasterTextWindows(20000, 20000, full), /budget/);
  assert.throws(
    () => rasterTextWindows(1000, 1000, { ...full, x0: -0.1 }),
    /Invalid/,
  );
});

test("OCR uses actual rounded source frame and rejects weak, clipped and invalid boxes", () => {
  const line = {
    text: "  MASTER\nBATH ",
    confidence: 85,
    bbox: { x0: 10, y0: 20, x1: 110, y1: 45 },
  };
  const region = { x0: 0.201, y0: 0.103, x1: 0.451, y1: 0.603 };
  const result = rasterTextRuns(
    [
      line,
      { ...line, confidence: 69 },
      { ...line, bbox: { ...line.bbox, x0: 0 } },
      { ...line, confidence: NaN },
      { ...line, bbox: { ...line.bbox, x1: 600 } },
    ],
    500,
    1000,
    region,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "MASTER BATH");
  assert.ok(Math.abs(result[0].x - 0.206) < 1e-12);
  assert.ok(Math.abs(result[0].y - 0.113) < 1e-12);
  assert.ok(Math.abs(result[0].w - 0.05) < 1e-12);
  assert.ok(Math.abs(result[0].h - 0.0125) < 1e-12);
  assert.deepEqual(result[0].ocr, {
    profile: RASTER_TEXT_PROFILE,
    confidence: 85,
  });
});

test("source text wins overlaps and overlapping OCR windows do not duplicate tags", () => {
  const original = [{ ...run("Bath"), ocr: undefined }],
    weak = run("8ATH"),
    strong = { ...run("BATH"), ocr: { ...ocr, confidence: 95 } },
    separate = run("WIC", 0.6);
  assert.deepEqual(mergeArchitecturalTextRuns(original, [strong, separate]), [
    ...original,
    separate,
  ]);
  assert.deepEqual(mergeArchitecturalTextRuns([], [weak, strong, separate]), [
    strong,
    separate,
  ]);
  assert.equal(original.length, 1);
});

test("OCR provenance survives saved text and invalid provenance never becomes authoritative", () => {
  assert.deepEqual(parseTextRuns(encodeTextRuns([run("BEDROOM")])), [
    run("BEDROOM"),
  ]);
  for (const invalid of [
    null,
    0,
    "bad",
    { profile: RASTER_TEXT_PROFILE, confidence: 101 },
    { profile: "", confidence: 90 },
  ]) {
    assert.deepEqual(
      parseTextRuns(
        JSON.stringify({
          version: 1,
          runs: [{ ...run("BEDROOM"), ocr: invalid }],
        }),
      ),
      [],
    );
  }
  assert.equal(authoritativeDimensionText(run(`18'-8"`)), false);
  assert.equal(
    authoritativeDimensionText({ ...run(`18'-8"`), ocr: undefined }),
    true,
  );
});

test("derived OCR cache rejects missing provenance, wrong profiles and impossible coordinates", () => {
  const value = {
    profile: RASTER_TEXT_PROFILE,
    status: "processed",
    runs: [run("BEDROOM")],
    windows: 1,
    warnings: [],
  };
  assert.equal(validRasterTextEvidence(value), true);
  for (const bad of [
    { ...value, profile: "old" },
    ...[
      null,
      0,
      "fake",
      { kind: "original-pdf", hash: "bad", sampling: null },
    ].map((source) => ({ ...value, source })),
    { ...value, windows: 0 },
    { ...value, runs: [{ ...run("BEDROOM"), ocr: undefined }] },
    { ...value, runs: [{ ...run("BEDROOM"), x: 1 }] },
    {
      ...value,
      runs: [{ ...run("BEDROOM"), ocr: { ...ocr, confidence: 101 } }],
    },
  ])
    assert.equal(validRasterTextEvidence(bad), false);
});

test("OCR dimensions cannot erase linework as exact positioned PDF dimensions", () => {
  const edges = [
    { a: [0, 0], b: [12, 0], source: "drawn" },
    { a: [0, -0.2], b: [0.2, 0.2], source: "drawn" },
    { a: [11.8, -0.2], b: [12.2, 0.2], source: "drawn" },
  ];
  const dimensions = [{ text: `12'-0"`, x: 0.45, y: 0.01, w: 0.1, h: 0.03 }];
  const exact = filterAreaDimensions(edges, dimensions, 12, 12),
    uncertain = filterAreaDimensions(
      edges,
      dimensions.map((r) => ({ ...r, ocr })),
      12,
      12,
    );
  assert.equal(exact.dimensions, 1);
  assert.equal(uncertain.dimensions, 0);
  assert.deepEqual(uncertain.edges, edges);
});

test("compound room tags keep transcription uncertainty and do not name standalone pools", () => {
  const first = {
      ...run("Pool.", 0.3, 0.3),
      w: 0.1,
      h: 0.03,
      ocr: { ...ocr, confidence: 79 },
    },
    second = {
      ...run("BATH", 0.305, 0.345),
      w: 0.09,
      h: 0.03,
      ocr: { ...ocr, confidence: 93 },
    };
  const joined = areaTextRuns([first, second]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].text, "Pool BATH");
  assert.equal(joined[0].ocr.confidence, 79);
  assert.equal(areaRoomLabel(joined[0].text), "Pool BATH");
  assert.equal(areaRoomLabel("POOL"), null);
  assert.equal(areaTextRuns([first, second, { ...second, x: 0.3 }]).length, 3);
});

test("the shared engine and saved replay use the same OCR source labels for takeoff and 3D", async () => {
  const evidence = {
    version: 1,
    truncated: false,
    raster: {
      width: 1000,
      height: 1000,
      feetPerPixel: 0.02,
      threshold: 140,
      maximumDeviationPixels: 0.8,
      region: full,
    },
    paths: [
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
        [0.1, 0.1],
      ],
      [
        [0.125, 0.125],
        [0.875, 0.125],
        [0.875, 0.875],
        [0.125, 0.875],
        [0.125, 0.125],
      ],
    ].map((points, id) => ({
      id,
      kind: "stroke",
      commands: points.map((p, i) => [i ? "L" : "M", ...p]),
      layer: ["A-WALL"],
      opacity: 1,
      width: 1,
      color: [0],
      colorSpace: "DeviceGray",
      groups: [],
      clips: [],
      dashes: [],
      evenOdd: false,
    })),
    rasterText: {
      profile: RASTER_TEXT_PROFILE,
      status: "processed",
      runs: [run("BEDROOM")],
      windows: 1,
      warnings: ["Provisional OCR text"],
    },
  };
  const source = {
    evidence,
    textRuns: [],
    segments: [],
    imageWidth: 1000,
    imageHeight: 1000,
    feetPerImagePx: 0.02,
    region: full,
    finishPolicy: "include-fixtures",
  };
  const result = await runAreaEngine(source, { wholeSheet: true }),
    level = buildingToFloorplan(
      {
        ...source,
        sheetVersionId: "00000000-0000-4000-8000-000000000001",
        sheetNumber: "A1",
        sheetTitle: "Floor",
        name: "Ground",
        order: 0,
      },
      result.detection.architecture,
    );
  assert.equal(level.rooms.length, 1);
  assert.equal(level.rooms[0].label, "BEDROOM");
  assert.equal(level.rooms[0].areaSqft, 225);
  assert.equal(level.rooms[0].areaSqft, result.detection.proposals[0].areaSqft);
  assert.ok(
    level.reconstruction.issues.some((i) => i.code === "raster-text-review"),
  );
  assert.ok(result.detection.warnings.includes("Provisional OCR text"));
  const replay = await replayAreaDetection(
    createAreaReplay(source, true, {}, result.recognition),
  );
  assert.deepEqual(
    replay.detection.architecture,
    result.detection.architecture,
  );
  assert.equal(source.textRuns.length, 0);
});
