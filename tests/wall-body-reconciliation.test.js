require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  reconcileMeasuredWallBodies,
} = require("../lib/drawings/wall-body-reconciliation");
const body = (a, b, thicknessFt = 1, pathIds = [1, 2], independent = true) => ({
  a,
  b,
  thicknessFt,
  pathIds,
  independent,
});
const anchor = () => body([0, 0], [10, 0]),
  detail = () => body([0, 0.1], [11, 0.1], 0.8, [1, 3], false);
test("only fully covered depth sharing a measured source face is consolidated; uncovered tail survives", () => {
  const input = [anchor(), detail()],
    r = reconcileMeasuredWallBodies(input);
  assert.equal(r.limited, false);
  assert.deepEqual(r.invalidIndices, []);
  assert.deepEqual(r.bodies[0], {
    sourceIndex: 0,
    a: [0, 0],
    b: [10, 0],
    thicknessFt: 1,
    pathIds: [1, 2],
  });
  assert.deepEqual(r.bodies[1], {
    sourceIndex: 1,
    a: [10, 0.1],
    b: [11, 0.1],
    thicknessFt: 0.8,
    pathIds: [1, 3],
  });
  assert.deepEqual(r.covered, [
    { sourceIndex: 1, by: [0], startFt: 0, endFt: 10 },
  ]);
  assert.deepEqual(input, [anchor(), detail()]);
});
test("proximity, partial-depth overlap, unrelated faces and unproven anchors cannot remove a body", () => {
  for (const weak of [
    body([0, 0.3], [11, 0.3], 0.8, [1, 3], false),
    body([0, 0], [11, 0], 0.8, [1, 3], false),
    body([0, 0.1], [11, 0.1], 0.8, [7, 8], false),
  ]) {
    const r = reconcileMeasuredWallBodies([anchor(), weak]);
    assert.equal(r.bodies.length, 2);
    assert.deepEqual(r.bodies[1].a, weak.a);
    assert.deepEqual(r.bodies[1].b, weak.b);
    assert.deepEqual(r.covered, []);
  }
  assert.equal(
    reconcileMeasuredWallBodies([{ ...anchor(), independent: false }, detail()])
      .covered.length,
    0,
  );
  assert.equal(
    reconcileMeasuredWallBodies([anchor(), { ...detail(), independent: true }])
      .covered.length,
    0,
  );
});
test("both uncovered ends survive at original thickness and source positions", () => {
  const weak = body([-2, 0.1], [12, 0.1], 0.8, [1, 3], false),
    r = reconcileMeasuredWallBodies([anchor(), weak]);
  assert.deepEqual(
    r.bodies.filter((b) => b.sourceIndex === 1).map((b) => [b.a, b.b]),
    [
      [
        [-2, 0.1],
        [0, 0.1],
      ],
      [
        [10, 0.1],
        [12, 0.1],
      ],
    ],
  );
  assert.ok(
    r.bodies.every((b) => b.sourceIndex === 0 || b.thicknessFt === 0.8),
  );
});
test("coverage union preserves a real sub-inch gap rather than joining source spans", () => {
  const r = reconcileMeasuredWallBodies([
    body([0, 0], [4, 0]),
    body([4.01, 0], [10, 0]),
    body([0, 0.1], [10, 0.1], 0.8, [1, 3], false),
  ]);
  const gap = r.bodies.find((b) => b.sourceIndex === 2);
  assert.deepEqual(gap.a, [4, 0.1]);
  assert.deepEqual(gap.b, [4.01, 0.1]);
  assert.equal(r.covered.length, 2);
});
test("rotation, large page translations and reversed source direction preserve coverage geometry", () => {
  const angle = 0.41,
    rotate = (p) => [
      1234 + p[0] * Math.cos(angle) - p[1] * Math.sin(angle),
      2345 + p[0] * Math.sin(angle) + p[1] * Math.cos(angle),
    ];
  for (const reverse of [false, true]) {
    const input = [anchor(), detail()].map((b) => ({
        ...b,
        a: rotate(reverse ? b.b : b.a),
        b: rotate(reverse ? b.a : b.b),
      })),
      r = reconcileMeasuredWallBodies(input),
      tail = r.bodies.find((b) => b.sourceIndex === 1);
    assert.ok(tail);
    const expected = [rotate([10, 0.1]), rotate([11, 0.1])];
    assert.ok(
      expected.every((p) =>
        [tail.a, tail.b].some(
          (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-8,
        ),
      ),
    );
    assert.ok(
      Math.abs(Math.hypot(tail.b[0] - tail.a[0], tail.b[1] - tail.a[1]) - 1) <
        1e-8,
    );
  }
});
test("micro source tails remain mathematical evidence; no minimum length erases them", () => {
  const r = reconcileMeasuredWallBodies([
      anchor(),
      body([0, 0.1], [10.0001, 0.1], 0.8, [1, 3], false),
    ]),
    tail = r.bodies.find((b) => b.sourceIndex === 1);
  assert.ok(tail);
  assert.deepEqual(tail.a, [10, 0.1]);
  assert.deepEqual(tail.b, [10.0001, 0.1]);
});
test("invalid source geometry and an oversized source budget preserve original candidates explicitly", () => {
  const invalid = { ...detail(), thicknessFt: NaN },
    r = reconcileMeasuredWallBodies([anchor(), invalid]);
  assert.deepEqual(r.invalidIndices, [1]);
  assert.equal(r.covered.length, 0);
  assert.equal(r.bodies.length, 2);
  const many = Array.from({ length: 12001 }, () => anchor()),
    limited = reconcileMeasuredWallBodies(many);
  assert.equal(limited.limited, true);
  assert.equal(limited.bodies.length, many.length);
  assert.equal(limited.covered.length, 0);
});
test("source-body consolidation is shared by reconstruction and the 3D projection, with measured tails reviewable", () => {
  const {
      reconstructBuilding,
    } = require("../lib/drawings/building-reconstruction"),
    { buildingToFloorplan } = require("../lib/drawings/building-floorplan");
  const stroke = (id, a, b, width = 1, layer = []) => ({
    id,
    commands: [
      ["M", a[0] / 100, a[1] / 100],
      ["L", b[0] / 100, b[1] / 100],
    ],
    kind: "stroke",
    color: [0],
    colorSpace: "DeviceGray",
    opacity: 1,
    width,
    dashes: [],
    layer,
    groups: [],
    clips: [],
    evenOdd: false,
  });
  const lines = [
      [
        [0, 0],
        [20, 0],
      ],
      [
        [0, 0.5],
        [20, 0.5],
      ],
      [
        [0, 10],
        [20, 10],
      ],
      [
        [0, 10.5],
        [20, 10.5],
      ],
      [
        [0, 0.5],
        [0, 10],
      ],
      [
        [0.5, 0.5],
        [0.5, 10],
      ],
      [
        [19.5, 0.5],
        [19.5, 10],
      ],
      [
        [20, 0.5],
        [20, 10],
      ],
      [
        [9.75, 0.5],
        [9.75, 10],
      ],
      [
        [10.25, 0.5],
        [10.25, 10],
      ],
    ],
    paths = lines.map(([a, b], id) => stroke(id, a, b));
  paths.push(
    stroke(20, [0, 0.0417], [21, 0.0417], 0.5, ["A_WALL"]),
    stroke(21, [0, 0.4583], [21, 0.4583], 0.5, ["A_WALL"]),
    stroke(22, [0, 0], [21, 0], 0.25, ["A_WALL"]),
  );
  // Reflected sheet convention exposes the nested candidate after finish expansion.
  for (const p of paths) p.commands = p.commands.map((c) => [c[0], c[2], c[1]]);
  const source = {
      imageWidth: 1000,
      imageHeight: 1000,
      feetPerImagePx: 0.1,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      segments: [],
      textRuns: [{ text: "ROOM 1", x: 0.04, y: 0.04, w: 0.02, h: 0.01 }],
      evidence: { version: 1, paths, truncated: false },
    },
    space = {
      id: "room",
      proposalId: "room",
      points: [
        [0.005, 0.005],
        [0.21, 0.005],
        [0.21, 0.1],
        [0.005, 0.1],
      ],
      holes: [],
      labels: ["ROOM 1"],
      sourceBoundaries: [
        { a: [0, 0.005], b: [0.2, 0.005], pathId: 1, source: "drawn" },
      ],
      boundary: {
        supportedFraction: 0,
        visualFraction: 0,
        unknownPathIds: [1],
        conflictedPathIds: [],
        status: "needs-review",
      },
    },
    architecture = {
      version: 1,
      spaces: [space],
      openings: [],
      elements: [],
      finishZones: [],
      conflicts: [],
      spacePolicy: "include-fixtures",
      qualification: "unqualified",
    };
  space.points = space.points.map((p) => [p[1], p[0]]);
  space.sourceBoundaries = space.sourceBoundaries.map((b) => ({
    ...b,
    a: [b.a[1], b.a[0]],
    b: [b.b[1], b.b[0]],
  }));
  architecture.building = reconstructBuilding(source, architecture);
  assert.ok(
    architecture.building.issues.some((i) => i.code === "competing-wall-body" && i.pathIds.includes(20) && i.pathIds.includes(21)),
  );
  const tails = architecture.building.walls.filter(
    (w) => w.pathIds.includes(20) && w.pathIds.includes(21),
  );
  assert.ok(tails.length);
  assert.ok(
    tails.every(
      (w) =>
        Math.hypot((w.b[0] - w.a[0]) * 100, (w.b[1] - w.a[1]) * 100) < 1.01,
    ),
  );
  const level = buildingToFloorplan(
    { ...source, sheetVersionId: "source", name: "Floor", order: 0 },
    architecture,
  );
  assert.ok(
    level.reconstruction.issues.some((i) => i.code === "competing-wall-body" && i.pathIds.includes(20) && i.pathIds.includes(21)),
  );
  assert.equal(level.walls.length, architecture.building.walls.length);
});
test("an exhausted work budget rolls back partial coverage instead of returning a truncated reconstruction", () => {
  const input = [
      ...Array.from({ length: 8000 }, () => anchor()),
      detail(),
      ...Array.from({ length: 3999 }, () =>
        body([0, 0.1], [11, 0.1], 0.8, [7, 8], false),
      ),
    ],
    r = reconcileMeasuredWallBodies(input);
  assert.equal(r.limited, true);
  assert.ok(r.operations > 2000000);
  assert.equal(r.covered.length, 0);
  assert.equal(r.bodies.length, input.length);
  assert.deepEqual(r.bodies[8000].a, [0, 0.1]);
  assert.deepEqual(r.bodies[8000].b, [11, 0.1]);
});
