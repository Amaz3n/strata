require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./support/raster-door-fixture");
const { rasterSwingDoors } = require("../lib/drawings/raster-swing-doors");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const {
  createAreaReplay,
  replayAreaDetection,
} = require("../lib/drawings/area-replay");
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
const { observedLeafCap } = require("../lib/drawings/raster-leaf-cap");
// The original pixel image and every observed contour interval stay identical.
// Only the encoder's subdivision and closed-ring start index vary.
function subdivide(evidence, rotation = 0) {
  return {
    ...evidence,
    paths: evidence.paths.map((p) => {
      if (p.rasterFeature !== "paint-boundary") return p;
      const commands = [p.commands[0]];
      for (let i = 1; i < p.commands.length; i++) {
        const a = p.commands[i - 1],
          b = p.commands[i];
        if (b[0] !== "L" || a.length < 3) {
          commands.push(b);
          continue;
        }
        for (let j = 1; j <= 8; j++)
          commands.push([
            "L",
            a[1] + ((b[1] - a[1]) * j) / 8,
            a[2] + ((b[2] - a[2]) * j) / 8,
          ]);
      }
      const first = commands[0],
        last = commands.at(-1);
      const closedRing =
        first[1] === last[1] &&
        first[2] === last[2] &&
        commands.every((c, i) => c[0] === (i ? "L" : "M"));
      if (rotation && closedRing) {
        const open = commands.slice(0, -1),
          offset = Math.floor(open.length * rotation),
          points = [...open.slice(offset), ...open.slice(0, offset)];
        return {
          ...p,
          commands: points
            .map((p, i) => [i ? "L" : "M", p[1], p[2]])
            .concat([["L", points[0][1], points[0][2]]]),
        };
      }
      return { ...p, commands };
    }),
  };
}
// Source subdivision changes floating-point evaluation order by machine epsilon.
// This comparison rounds at1e-12ft, far below pixel/qualification uncertainty.
const geometry = (r) =>
  JSON.parse(
    JSON.stringify(
      r.doors.map((d) => [
        d.a,
        d.b,
        d.clearSpan,
        d.leafWidthFt,
        d.thicknessFt,
        d.widthBasis,
      ]),
      (_, v) => (typeof v === "number" ? Math.round(v * 1e12) / 1e12 : v),
    ),
  );
test("subdivision and closed-ring indexing preserve a door drawn in identical original pixels", () => {
  const f = fixture(),
    baseline = rasterSwingDoors(f.args),
    snapshot = JSON.stringify(f.evidence);
  assert.equal(baseline.doors.length, 1);
  for (const rotation of [0, 0.2, 0.5, 0.8]) {
    const evidence = subdivide(f.evidence, rotation),
      r = rasterSwingDoors({ ...f.args, evidence });
    assert.equal(r.limited, false);
    assert.deepEqual(geometry(r), geometry(baseline));
    for (const d of r.doors)
      for (const id of [...d.doorPathIds, ...d.framePathIds])
        assert.ok(evidence.paths.some((p) => p.id === id));
  }
  assert.equal(JSON.stringify(f.evidence), snapshot);
});
test("small source segments cannot connect missing cap, leaf, jamb or swing pixels", () => {
  for (const missing of ["noEndCap", "noLeaf", "noJamb", "noArc"]) {
    const f = fixture({ [missing]: true });
    for (const rotation of [0, 0.5])
      assert.equal(
        rasterSwingDoors({
          ...f.args,
          evidence: subdivide(f.evidence, rotation),
        }).doors.length,
        0,
        missing,
      );
  }
});
test("consecutive stepped tip ink qualifies; separate routes, white gaps, excessive detours and exhausted work do not", () => {
  const tip = [0, 0],
    axis = [0, 1],
    depth = 0.1,
    error = 0.03,
    pixel = 0.01;
  const route = {
    id: 9,
    points: [
      [-0.05, -0.01],
      [-0.02, -0.01],
      [0, 0.005],
      [0.025, -0.005],
      [0.05, -0.005],
    ],
  };
  assert.deepEqual(
    observedLeafCap([route], tip, axis, depth, error, pixel, () => true),
    { id: 9 },
  );
  assert.equal(
    observedLeafCap(
      [
        { id: 9, points: route.points.slice(0, 3) },
        { id: 10, points: route.points.slice(3) },
      ],
      tip,
      axis,
      depth,
      error,
      pixel,
      () => true,
    ),
    null,
  );
  assert.equal(
    observedLeafCap(
      [
        {
          id: 9,
          points: [
            [-0.05, 0],
            [-0.02, 0],
            [-0.02, 1],
            [0.02, 1],
            [0.02, 0],
            [0.05, 0],
          ],
        },
      ],
      tip,
      axis,
      depth,
      error,
      pixel,
      () => true,
    ),
    null,
  );
  assert.equal(
    observedLeafCap(
      [
        {
          id: 9,
          points: [
            [-0.05, 0],
            [0, 0.03],
            [-0.05, 0],
            [0, -0.03],
            [0.05, 0],
          ],
        },
      ],
      tip,
      axis,
      depth,
      error,
      pixel,
      () => true,
    ),
    null,
  );
  // Sampling uncertainty must not let a narrow leaf borrow a return loop
  // that crosses both faces but begins and ends on the same side.
  assert.equal(
    observedLeafCap(
      [
        {
          id: 9,
          points: [
            [-0.03, 0],
            [0.03, 0],
            [-0.03, 0],
          ],
        },
      ],
      tip,
      axis,
      0.06,
      0.06,
      pixel,
      () => true,
    ),
    null,
  );
  assert.equal(
    observedLeafCap([route], tip, axis, depth, error, pixel, () => false),
    null,
  );
});
test("shared takeoff, 3D dimensions and immutable replay agree after contour subdivision", async () => {
  const f = fixture(),
    input = { ...f.input, evidence: subdivide(f.evidence, 0.5) },
    r = await runAreaEngine(input, {
      wholeSheet: true,
      maxRecognitionWindows: 1,
    }),
    b = r.detection.architecture.building;
  assert.equal(b.openings.length, 1);
  const o = b.openings[0],
    level = buildingToFloorplan(
      {
        ...input,
        sheetVersionId: "00000000-0000-4000-8000-000000000001",
        sheetNumber: null,
        sheetTitle: null,
        name: "Floor",
        order: 0,
        scaleConfirmed: true,
      },
      r.detection.architecture,
    );
  assert.equal(level.openings.length, 1);
  assert.equal(level.openings[0].clearWidthFt, o.clearWidthFt);
  assert.equal(level.openings[0].leafWidthFt, o.leafWidthFt);
  const replay = await replayAreaDetection(
    createAreaReplay(input, true, {}, r.recognition),
  );
  assert.deepEqual(replay.detection.architecture.building, b);
  assert.deepEqual(replay.recognitionCoverage, r.recognitionCoverage);
});
