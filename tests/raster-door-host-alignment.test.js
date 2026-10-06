require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./support/raster-door-fixture");
const {
  extractRasterPlanEvidence,
} = require("../lib/drawings/raster-plan-evidence");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const {
  createAreaReplay,
  replayAreaDetection,
} = require("../lib/drawings/area-replay");
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
const { floorplanModelSchema } = require("../lib/validation/floorplan");
function scan(options = {}, shift = 1) {
  const f = fixture(options),
    r = f.rasterInput,
    pixels = new Uint8Array(r.pixels.length).fill(255);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const target = x + (y >= 340 ? shift : 0);
      if (target >= 0 && target < r.width)
        pixels[y * r.width + target] = r.pixels[y * r.width + x];
    }
  return {
    ...f.input,
    textRuns: [],
    evidence: extractRasterPlanEvidence({ ...r, pixels }),
  };
}
test("a one-pixel scanned jamb offset uses measured source uncertainty consistently in takeoff and 3D", async () => {
  const input = scan(),
    run = await runAreaEngine(input, {
      wholeSheet: true,
      maxRecognitionWindows: 0,
    }),
    b = run.detection.architecture.building;
  assert.equal(b.openings.length, 1);
  assert.ok(b.issues.some((i) => i.code === "door-leaf-assembly"));
  const level = buildingToFloorplan(
    {
      ...input,
      sheetVersionId: "00000000-0000-4000-8000-000000000001",
      sheetNumber: null,
      sheetTitle: null,
      name: "Floor",
      order: 0,
      scaleConfirmed: true,
    },
    run.detection.architecture,
  );
  floorplanModelSchema.parse({
    version: 1,
    units: "feet",
    levels: [level],
    correctionCount: 0,
  });
  assert.equal(level.openings[0].clearWidthFt, b.openings[0].clearWidthFt);
  assert.equal(level.openings[0].leafWidthFt, b.openings[0].leafWidthFt);
  const replay = await replayAreaDetection(
    createAreaReplay(input, true, {}, run.recognition),
  );
  assert.deepEqual(replay.detection.architecture.building, b);
  assert.deepEqual(replay.recognitionCoverage, run.recognitionCoverage);
});
test("source uncertainty cannot replace missing swing, leaf, jamb or tip pixels", async () => {
  for (const missing of ["noArc", "noLeaf", "noJamb", "noEndCap"]) {
    const run = await runAreaEngine(scan({ [missing]: true }), {
      wholeSheet: true,
      maxRecognitionWindows: 0,
    });
    assert.equal(
      run.detection.architecture.building.openings.length,
      0,
      missing,
    );
  }
  const displaced = await runAreaEngine(scan({}, 20), {
    wholeSheet: true,
    maxRecognitionWindows: 0,
  });
  assert.equal(displaced.detection.architecture.building.openings.length, 0);
});
