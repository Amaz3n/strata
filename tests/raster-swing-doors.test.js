require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  extractRasterPlanEvidence,
} = require("../lib/drawings/raster-plan-evidence");
const { rasterSwingDoors } = require("../lib/drawings/raster-swing-doors");
const { sourceWallNetwork } = require("../lib/drawings/vector-wall-network");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const {
  createAreaReplay,
  replayAreaDetection,
} = require("../lib/drawings/area-replay");
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
const { floorplanModelSchema } = require("../lib/validation/floorplan");
const {fixture}=require('./support/raster-door-fixture')

test("observed swing, capped two-face leaf, connected jambs and independently supported flanks establish one provisional door", () => {
  const f = fixture(),
    r = rasterSwingDoors(f.args);
  assert.equal(f.evidence.truncated, false);
  assert.ok(f.args.wallBodies.length >= 5);
  assert.equal(r.limited, false);
  assert.equal(r.doors.length, 1);
  const d = r.doors[0];
  assert.equal(d.basis, "raster-swing-leaf");
  assert.equal(d.widthBasis, "wall-flank-span");
  assert.ok(d.clearSpan);
  assert.ok(d.leafWidthFt > 2.4 && d.leafWidthFt < 2.7);
  assert.ok(d.jambs.length >= 2);
  assert.ok(d.sourceUncertaintyFt <= 0.1);
});
test("a gap or a curve does not replace missing leaf, end cap or jamb evidence", () => {
  for (const option of ["noLeaf", "noEndCap", "noJamb", "noArc"]) {
    const f = fixture({ [option]: true });
    assert.equal(rasterSwingDoors(f.args).doors.length, 0, option);
  }
});
test("clipped, corrupt, partial or conflicting source evidence cannot manufacture a door", () => {
  const f = fixture(),
    arc = f.evidence.paths.find((p) => p.rasterArc);
  assert.ok(arc);
  const changed = (fn) => ({
    ...f.args,
    evidence: {
      ...f.evidence,
      paths: f.evidence.paths.map((p) => (p.rasterArc ? fn(p) : p)),
    },
  });
  const clipped = rasterSwingDoors(
    changed((p) => ({ ...p, rasterArc: { ...p.rasterArc, clipped: true } })),
  );
  assert.equal(clipped.doors.length, 0);
  assert.deepEqual(
    clipped.diagnostics.clippedRasterArcIds,
    f.evidence.paths.filter((p) => p.rasterArc).map((p) => p.id),
  );
  for (const edit of [
    (p) => ({ ...p, rasterArc: undefined }),
    (p) => ({
      ...p,
      rasterArc: { ...p.rasterArc, maximumDeviationPixels: Infinity },
    }),
    (p) => ({ ...p, rasterArc: { ...p.rasterArc, continuousInk: false } }),
  ])
    assert.equal(rasterSwingDoors(changed(edit)).doors.length, 0);
  assert.equal(
    rasterSwingDoors({
      ...f.args,
      evidence: { ...f.evidence, truncated: true },
    }).doors.length,
    0,
  );
  assert.equal(
    rasterSwingDoors({ ...f.args, pathKinds: new Map([[arc.id, "fixture"]]) })
      .doors.length,
    0,
  );
  assert.equal(rasterSwingDoors({ ...f.args, wallBodies: [] }).doors.length, 0);
});
test("shared takeoff, 3D projection and replay preserve source width distinctions and provisional review", async () => {
  const f = fixture(),
    r = await runAreaEngine(f.input, {
      wholeSheet: true,
      maxRecognitionWindows: 1,
    });
  const b = r.detection.architecture.building;
  assert.equal(b.openings.length, 1);
  const o = b.openings[0];
  assert.equal(o.widthBasis, "wall-flank-span");
  assert.ok(o.clearWidthFt > 0);
  assert.ok(o.leafWidthFt > 0);
  assert.ok(
    b.walls.some((w) => w.id === o.wallId && w.basis === "opening-host"),
  );
  assert.ok(r.detection.openingEvidence.length > 0);
  const level = buildingToFloorplan(
    {
      ...f.input,
      sheetVersionId: "00000000-0000-4000-8000-000000000001",
      sheetNumber: null,
      sheetTitle: null,
      name: "Floor",
      order: 0,
      scaleConfirmed: true,
    },
    r.detection.architecture,
  );
  const parsed = floorplanModelSchema.parse({
    version: 1,
    units: "feet",
    levels: [level],
    correctionCount: 0,
  });
  assert.equal(parsed.levels[0].openings[0].clearWidthFt, o.clearWidthFt);
  assert.equal(parsed.levels[0].openings[0].leafWidthFt, o.leafWidthFt);
  const replay = await replayAreaDetection(
    createAreaReplay(f.input, true, {}, r.recognition),
  );
  assert.deepEqual(replay.detection.architecture.building.openings, b.openings);
  assert.equal(replay.recognition, "unavailable");
});

test("floor admission clips inferred faces to supported overlap instead of promoting annotation tails", () => {
  const { rasterSourceFaces } = require("../lib/drawings/raster-source-faces"),
    f = fixture(),
    network = sourceWallNetwork({
      evidence: f.evidence,
      sx: 12,
      sy: 12,
      textRuns: f.input.textRuns,
    });
  const snapshot = JSON.stringify(f.evidence),
    faces = rasterSourceFaces(f.evidence, network, 12, 12);
  assert.equal(faces.length, network.bodies.length * 2);
  assert.equal(JSON.stringify(f.evidence), snapshot);
  for (const face of faces) {
    const p = f.evidence.paths.find((p) => p.id === face.pathId),
      a = p.commands[0].slice(1),
      b = p.commands[1].slice(1),
      d = [b[0] - a[0], b[1] - a[1]],
      len2 = d[0] ** 2 + d[1] ** 2;
    for (const point of [face.a, face.b]) {
      const t = ((point[0] - a[0]) * d[0] + (point[1] - a[1]) * d[1]) / len2;
      assert.ok(t >= -1e-8 && t <= 1 + 1e-8);
      assert.ok(
        Math.abs((point[0] - a[0]) * d[1] - (point[1] - a[1]) * d[0]) < 1e-8,
      );
    }
  }
  assert.deepEqual(
    rasterSourceFaces(f.evidence, { ...network, limited: true }, 12, 12),
    [],
  );
});

test("unrelated distant sheet contours cannot exhaust assembly before an observed door is inspected", () => {
  const f = fixture(),
    baseline = rasterSwingDoors(f.args);
  const noise = Array.from({ length: 7000 }, (_, index) => ({
    ...f.evidence.paths.find((p) => p.rasterFeature === "paint-boundary"),
    id: f.evidence.paths.length + index,
    commands: [
      ["M", 0.85, 0.005],
      ["L", 0.86, 0.005],
      ["L", 0.86, 0.015],
      ["L", 0.85, 0.015],
      ["L", 0.85, 0.005],
    ],
  }));
  const result = rasterSwingDoors({
    ...f.args,
    evidence: { ...f.evidence, paths: [...noise, ...f.evidence.paths] },
  });
  assert.equal(result.limited, false);
  assert.deepEqual(result.doors, baseline.doors);
  // Even with the surrounding source clutter, a missing cap remains missing.
  const missing = fixture({ noEndCap: true });
  assert.equal(
    rasterSwingDoors({
      ...missing.args,
      evidence: {
        ...missing.evidence,
        paths: [...noise, ...missing.evidence.paths],
      },
    }).doors.length,
    0,
  );
});

test("a complete observed assembly independently corroborates only its source flanks without room text", async () => {
  const f = fixture(),
    network = sourceWallNetwork({
      evidence: f.evidence,
      sx: 12,
      sy: 12,
      textRuns: [],
    });
  assert.equal(network.bodies.length, 0);
  const args = {
    ...f.args,
    wallBodies: [],
    candidateWallBodies: network.candidates,
  };
  const result = rasterSwingDoors(args);
  assert.equal(result.limited, false);
  assert.equal(result.doors.length, 1);
  for (const candidateWallBodies of [
    [],
    network.candidates.map((b) => ({ ...b, thicknessFt: b.thicknessFt + 0.1 })),
    network.candidates.map((b) => ({ ...b, a: [b.a[0] + 0.001, b.a[1]] })),
  ])
    assert.equal(
      rasterSwingDoors({ ...args, candidateWallBodies }).doors.length,
      0,
    );
  const run = await runAreaEngine(
    { ...f.input, textRuns: [] },
    { wholeSheet: true, maxRecognitionWindows: 1 },
  );
  const building = run.detection.architecture.building;
  assert.equal(building.openings.length, 1);
  assert.equal(
    building.walls.filter((w) => w.basis !== "opening-host").length,
    2,
  );
  assert.equal(run.detection.architecture.spaces.length, 0);
  assert.ok(building.issues.some((i) => i.code === "raster-wall-assembly"));
});

test("changing the start index of a closed source contour cannot cut a measured jamb", () => {
  const f = fixture(),
    baseline = rasterSwingDoors(f.args);
  for (const fraction of [0.2, 0.5, 0.8]) {
    const paths = f.evidence.paths.map((p) => {
      if (p.rasterFeature !== "paint-boundary" || p.commands.length < 5)
        return p;
      const points = p.commands.map((c) => [c[1], c[2]]),
        first = points[0],
        last = points.at(-1);
      if (first[0] !== last[0] || first[1] !== last[1]) return p;
      const open = points.slice(0, -1),
        offset = Math.floor(open.length * fraction),
        rotated = [...open.slice(offset), ...open.slice(0, offset)];
      return {
        ...p,
        commands: rotated
          .map((p, i) => [i ? "L" : "M", ...p])
          .concat([["L", ...rotated[0]]]),
      };
    });
    const result = rasterSwingDoors({
      ...f.args,
      evidence: { ...f.evidence, paths },
    });
    assert.equal(result.limited, false);
    assert.equal(result.doors.length, baseline.doors.length);
    assert.deepEqual(
      result.doors.map((d) => [d.a, d.b, d.clearSpan, d.leafWidthFt]),
      baseline.doors.map((d) => [d.a, d.b, d.clearSpan, d.leafWidthFt]),
    );
  }
});
