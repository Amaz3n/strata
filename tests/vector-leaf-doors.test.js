require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { vectorWallNetwork } = require("../lib/drawings/vector-wall-network");
const { vectorLeafDoors } = require("../lib/drawings/vector-leaf-doors");
const {
  vectorSourceVisibility,
} = require("../lib/drawings/vector-source-visibility");
const { detectAreas } = require("../lib/drawings/area-takeoff");
const {
  reconstructBuilding,
} = require("../lib/drawings/building-reconstruction");
const stroke = (id, a, b, width = 1) => ({
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
  layer: [],
  groups: [],
  clips: [],
  evenOdd: false,
});
function fixture() {
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
      [0, 4],
    ],
    [
      [0.5, 0.5],
      [0.5, 4],
    ],
    [
      [0, 7],
      [0, 10],
    ],
    [
      [0.5, 7],
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
  ];
  const paths = lines.map(([a, b], id) => stroke(id, a, b));
  let id = 12;
  const rectangle = (x0, y0, x1, y1) => {
    const points = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    for (let i = 0; i < 4; i++)
      paths.push(stroke(id++, points[i], points[(i + 1) % 4], 0.5));
  };
  rectangle(0, 4, 0.5, 4.1);
  rectangle(0, 6.9, 0.5, 7);
  rectangle(0.5, 4.1, 3.3, 4.22);
  return {
    evidence: { version: 1, paths, truncated: false },
    sx: 100,
    sy: 100,
    textRuns: [{ text: "ROOM 1", x: 0.04, y: 0.045, w: 0.02, h: 0.01 }],
  };
}
function recognize(input, extra = {}) {
  const network = vectorWallNetwork(input);
  return vectorLeafDoors({
    ...input,
    wallBodies: network.bodies,
    candidateWallBodies: network.candidates,
    pathKinds: new Map(),
    ...extra,
  });
}
test("arc-less leaf and both measured frames establish rough aperture distinct from clear/leaf width", () => {
  const r = recognize(fixture());
  assert.equal(r.doors.length, 1);
  assert.equal(r.limited, false);
  const d = r.doors[0];
  assert.deepEqual(
    [d.a, d.b],
    [
      [0.0025, 0.04],
      [0.0025, 0.07],
    ],
  );
  assert.ok(Math.abs(d.thicknessFt - 0.5) < 1e-8);
  assert.deepEqual(
    d.doorPathIds.sort((a, b) => a - b),
    [20, 21, 22, 23],
  );
  assert.deepEqual(
    d.wallPathIds.sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
  assert.equal(d.framePathIds.length, 8);
  const f = fixture(),
    source = {
      ...f,
      imageWidth: 1000,
      imageHeight: 1000,
      feetPerImagePx: 0.1,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      segments: [],
    };
  const detection = detectAreas(source);
  assert.ok(
    detection.openingEvidence.some(
      (e) =>
        Math.abs(e.a[0] - 0.0025) < 1e-9 && Math.abs(e.b[0] - 0.0025) < 1e-9,
    ),
  );
  const architecture = {
    version: 1,
    spaces: [],
    openings: [],
    elements: [],
    finishZones: [],
    conflicts: [],
    spacePolicy: "include-fixtures",
    qualification: "unqualified",
  };
  const building = reconstructBuilding(source, architecture),
    opening = building.openings.find((o) => o.pathIds.includes(20));
  assert.ok(opening);
  assert.equal(opening.widthBasis, "jamb-span");
  assert.ok(Math.abs(opening.widthFt - 3) < 1e-9);
  assert.ok(building.issues.some((i) => i.code === "door-leaf-assembly"));
});
test("a gap, lone frame, missing leaf, remote or conflicting fixture geometry cannot establish a door", () => {
  for (const removed of [[20, 21, 22, 23], [12], [16, 17, 18, 19], [4, 5]]) {
    const f = fixture();
    f.evidence.paths = f.evidence.paths.filter((p) => !removed.includes(p.id));
    assert.equal(recognize(f).doors.length, 0);
  }
  for (const kind of ["window", "fixture", "furniture", "annotation"])
    assert.equal(
      recognize(fixture(), { pathKinds: new Map([[20, kind]]) }).doors.length,
      0,
    );
  const f = fixture();
  f.evidence.paths = f.evidence.paths.map((p) =>
    p.id < 20
      ? p
      : { ...p, commands: p.commands.map((c) => [c[0], c[1] + 0.1, c[2]]) },
  );
  assert.equal(recognize(f).doors.length, 0);
  const paint = fixture();
  paint.evidence.paths = paint.evidence.paths.map((p) =>
    p.id < 20 ? p : { ...p, color: [0.2] },
  );
  assert.equal(recognize(paint).doors.length, 0);
});
test("unseeded flanks require a valid network anchor, and fabricated bodies fail provenance checks", () => {
  const f = fixture(),
    n = vectorWallNetwork(f);
  assert.equal(recognize(f, { wallBodies: [] }).doors.length, 0);
  const anchor = n.bodies.filter((b) => b.pathIds.includes(6));
  assert.equal(recognize(f, { wallBodies: anchor }).doors.length, 1);
  assert.equal(
    recognize(f, {
      wallBodies: anchor.map((b) => ({ ...b, a: [b.a[0] + 0.1, b.a[1]] })),
    }).doors.length,
    0,
  );
  assert.equal(
    recognize(f, {
      candidateWallBodies: n.candidates.map((b) => ({
        ...b,
        pathIds: [9999, 10000],
      })),
    }).doors.length,
    0,
  );
});
test("rotation preserves measured source coordinates and ambiguous competing leaves fail closed", () => {
  const f = fixture(),
    angle = 0.39,
    rotate = (p) => [
      0.3 + p[0] * Math.cos(angle) - p[1] * Math.sin(angle),
      0.2 + p[0] * Math.sin(angle) + p[1] * Math.cos(angle),
    ];
  f.evidence.paths = f.evidence.paths.map((p) => ({
    ...p,
    commands: p.commands.map((c) => [c[0], ...rotate([c[1], c[2]])]),
  }));
  const centre = rotate([0.05, 0.05]);
  f.textRuns = [{ text: "ROOM 1", x: centre[0], y: centre[1], w: 0, h: 0 }];
  const r = recognize(f);
  assert.equal(r.doors.length, 1);
  const expected = [rotate([0.0025, 0.04]), rotate([0.0025, 0.07])];
  assert.ok(
    expected.every((p) =>
      [r.doors[0].a, r.doors[0].b].some(
        (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9,
      ),
    ),
  );
  const ambiguous = fixture(),
    points = [
      [0.5, 4.1],
      [3.3, 4.1],
      [3.3, 4.3],
      [0.5, 4.3],
    ];
  ambiguous.evidence.paths.push(
    ...points.map((p, i) => stroke(30 + i, p, points[(i + 1) % 4], 0.5)),
  );
  assert.equal(recognize(ambiguous).doors.length, 0);
});
const mask = (id, x0, y0, x1, y1) => ({
  ...stroke(id, [0, 0], [0, 0]),
  kind: "fill",
  color: [1],
  commands: [
    ["M", x0, y0],
    ["L", x1, y0],
    ["L", x1, y1],
    ["L", x0, y1],
    ["L", x0, y0],
  ],
});
test("visibility checks full source segments: narrow erase paint between sample points rejects assemblies", () => {
  const f = fixture();
  f.evidence.paths.push(mask(100, 0.009, 0.0409, 0.011, 0.0411));
  assert.equal(recognize(f).doors.length, 0);
  const p = stroke(1, [0, 0], [10, 0]),
    m = mask(2, 0.024, -0.01, 0.026, 0.01),
    visible = vectorSourceVisibility({
      version: 1,
      truncated: false,
      paths: [p, m],
    });
  assert.equal(visible(p), false);
  assert.equal(
    vectorSourceVisibility({
      version: 1,
      truncated: false,
      paths: [{ ...m, id: 0 }, p],
    })(p),
    true,
  );
  const hole = mask(2, -0.01, -0.02, 0.11, 0.02);
  hole.evenOdd = true;
  hole.commands.push(["Z"]);
  hole.commands.push(...mask(3, -0.005, -0.01, 0.105, 0.01).commands);
  assert.equal(
    vectorSourceVisibility({ version: 1, truncated: false, paths: [p, hole] })(
      p,
    ),
    true,
  );
});
test("raster, truncated and unsupported clips never become vector leaf assemblies", () => {
  for (const overrides of [{ raster: {} }, { truncated: true }]) {
    const f = fixture();
    f.evidence = { ...f.evidence, ...overrides };
    assert.equal(recognize(f).doors.length, 0);
  }
  const f = fixture();
  f.evidence.paths = f.evidence.paths.map((p) => ({ ...p, clips: [999] }));
  assert.equal(recognize(f).doors.length, 0);
});

test("combinatorial source assemblies report an explicit limit instead of silent or partial success", () => {
  const f = fixture(),
    base = f.evidence.paths.filter((p) => p.id >= 12);
  for (let copy = 0; copy < 400; copy++)
    f.evidence.paths.push(
      ...base.map((p) => ({
        ...p,
        id: 1000 + copy * 12 + p.id,
        width: p.width + copy * 0.0001,
      })),
    );
  const r = recognize(f);
  assert.equal(r.limited, true);
  assert.deepEqual(r.doors, []);
  assert.ok(r.diagnostics.operations > 250000);
});
test("physical source graph competes with unknown interior partitions and preserves rejected geometry", () => {
  const f = fixture();
  f.evidence.paths.push(stroke(30, [4, 0.5], [4, 10], 0.25));
  f.textRuns = [{ text: "ROOM 1", x: 0.02, y: 0.045, w: 0.01, h: 0.01 }];
  const source = {
    ...f,
    imageWidth: 1000,
    imageHeight: 1000,
    feetPerImagePx: 0.1,
    region: { x0: 0, y0: 0, x1: 0.3, y1: 0.2 },
    segments: [],
    finishPolicy: "include-fixtures",
  };
  const d = detectAreas(source),
    room = d.proposals.find((p) => p.label === "ROOM 1");
  assert.ok(room);
  assert.ok(Math.abs(room.areaSqft - 88.575) < 1e-8);
  assert.ok(
    room.warnings.some((w) =>
      w.includes("Unclassified interior linework remains unresolved"),
    ),
  );
  assert.ok(d.boundaryConflicts.length);
  assert.ok(
    d.alternativeProposals.some(
      (p) => p.boundary.some((e) => e.pathId === 30) && p.areaSqft < 80,
    ),
  );
  assert.ok(!room.boundary.some((e) => e.pathId === 30));
  const {attachAreaArchitecture}=require('../lib/drawings/area-architecture')
  const {buildingToFloorplan}=require('../lib/drawings/building-floorplan')
  const architecture=attachAreaArchitecture(d,source).architecture
  architecture.building=reconstructBuilding(source,architecture)
  const level=buildingToFloorplan({...source,sheetVersionId:'source',name:'Floor',order:0},architecture)
  assert.ok(level.reconstruction.issues.some(i=>i.code==='floor-boundary-interpretations'&&i.objectId===`space:${room.id}`))
  const classified = detectAreas({
    ...source,
    visualObservations: [
      {
        id: "partition",
        region: source.region,
        suppliedPathIds: [30],
        elements: [{ kind: "wall", pathIds: [30] }],
        openings: [],
      },
    ],
  });
  assert.ok(
    classified.proposals.find((p) => p.label === "ROOM 1").areaSqft < 40,
  );
});
test("an earlier duplicate edge cannot replace corroborated wall provenance in the physical graph", () => {
  const f = fixture();
  f.evidence.paths.unshift({ ...f.evidence.paths[1], id: 99, width: 0.25 });
  f.evidence.paths.push(stroke(30, [4, 0.5], [4, 10], 0.25));
  f.textRuns = [{ text: "ROOM 1", x: 0.02, y: 0.045, w: 0.01, h: 0.01 }];
  const source = {
      ...f,
      imageWidth: 1000,
      imageHeight: 1000,
      feetPerImagePx: 0.1,
      region: { x0: 0, y0: 0, x1: 0.3, y1: 0.2 },
      segments: [],
      finishPolicy: "include-fixtures",
    },
    d = detectAreas(source),
    room = d.proposals.find((p) => p.label === "ROOM 1");
  assert.ok(Math.abs(room.areaSqft - 88.575) < 1e-8);
  assert.ok(room.boundary.some((e) => e.pathId === 1));
  assert.ok(!room.boundary.some((e) => e.pathId === 99));
});
