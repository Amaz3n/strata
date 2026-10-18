require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  consolidateAreaDeductions,
} = require("../lib/drawings/area-deduction-union");
const {
  detectAreas,
  ringArea,
  validateAreaGeometry,
} = require("../lib/drawings/area-takeoff");
const rect = (x, y, w = 1, h = 1) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const area = (rings) => rings.reduce((n, r) => n + ringArea(r), 0);

test("a subdivided column retains its exact footprint through a shared takeoff/room proposal", () => {
  const paths = [
    rect(0, 0, 20, 20),
    ...Array.from({ length: 12 * 12 }, (_, i) =>
      rect(5 + (i % 12) / 4, 5 + Math.floor(i / 12) / 4, 0.25, 0.25),
    ),
  ].map((ring, id) => ({
    id,
    kind: "stroke",
    commands: [
      ...ring.map((p, i) => [i ? "L" : "M", p[0] / 20, p[1] / 20]),
      ["Z"],
    ],
    color: [0],
    colorSpace: "DeviceGray",
    opacity: 1,
    width: 1,
    dashes: [],
    layer: [id ? "Columns" : "Walls"],
    groups: [],
    clips: [],
    evenOdd: false,
  }));
  const input = {
    segments: [],
    evidence: { version: 1, paths, truncated: false },
    textRuns: [{ text: "Entry", x: 0.6, y: 0.6, w: 0.1, h: 0.01 }],
    imageWidth: 1000,
    imageHeight: 1000,
    feetPerImagePx: 0.02,
    region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    finishPolicy: "include-fixtures",
  };
  const result = detectAreas(input),
    entry = result.proposals.find((p) => p.label === "Entry");
  assert.ok(entry);
  assert.equal(entry.holes.length, 1);
  assert.ok(Math.abs(entry.areaSqft - 391) < 1e-8);
  assert.doesNotThrow(() => validateAreaGeometry(entry));
  assert.ok(
    entry.warnings.some((w) => /without changing their deducted area/.test(w)),
  );
});

test("rotated triangular source subdivisions preserve footprint and area without snapping", () => {
  const cells = Array.from({ length: 400 }, (_, i) =>
    rect(i % 20, Math.floor(i / 20)),
  ).flatMap(([a, b, c, d]) => [
    [a, b, c],
    [a, c, d],
  ]);
  for (const angle of [0, 0.23, 1.14]) {
    // Transform each source vertex identically, as in a planar subdivision.
    const rotated = cells.map((r) =>
      r.map(([x, y]) => [
        73 + x * Math.cos(angle) - y * Math.sin(angle),
        91 + x * Math.sin(angle) + y * Math.cos(angle),
      ]),
    );
    const before = JSON.stringify(rotated),
      merged = consolidateAreaDeductions(rotated);
    assert.equal(merged.rings.length, 1);
    assert.equal(merged.consolidatedCells, 799);
    assert.equal(merged.unresolved, false);
    assert.ok(Math.abs(area(rotated) - area(merged.rings)) < 1e-8);
    assert.equal(JSON.stringify(rotated), before);
    assert.ok(
      merged.rings[0].every((p) =>
        rotated.some((r) => r.some((q) => p[0] === q[0] && p[1] === q[1])),
      ),
    );
  }
});

test("positive gaps and point-touching deductions stay separate", () => {
  for (const other of [rect(1.00000001, 0), rect(1, 1)]) {
    const rings = [rect(0, 0), other],
      result = consolidateAreaDeductions(rings);
    assert.deepEqual(result.rings, rings);
    assert.equal(result.consolidatedCells, 0);
  }
});

test("an enclosed floor island is never filled by flattening an annular deduction", () => {
  const rings = Array.from({ length: 9 }, (_, i) =>
    rect(i % 3, Math.floor(i / 3)),
  ).filter((_r, i) => i !== 4);
  const result = consolidateAreaDeductions(rings);
  assert.deepEqual(result.rings, rings);
  assert.equal(result.unresolved, true);
  assert.equal(area(result.rings), 8);
});

test("a concave union preserves its notch and independent deductions", () => {
  const rings = [rect(0, 0), rect(1, 0), rect(0, 1), rect(10, 10)];
  const result = consolidateAreaDeductions(rings);
  assert.equal(result.rings.length, 2);
  assert.equal(result.rings[0].length, 6);
  assert.equal(area(result.rings), 4);
  assert.equal(result.unresolved, false);
});

test("mixed winding is normalized without changing source rings", () => {
  const rings = [rect(0, 0).reverse(), rect(1, 0)],
    before = JSON.stringify(rings);
  const result = consolidateAreaDeductions(rings);
  assert.equal(result.rings.length, 1);
  assert.equal(area(result.rings), 2);
  assert.equal(JSON.stringify(rings), before);
});

test("a large source subdivision stays within the supported topology budget", () => {
  const cells = Array.from({ length: 10000 }, (_, i) =>
    rect(i % 100, Math.floor(i / 100)),
  );
  const result = consolidateAreaDeductions(cells);
  assert.equal(result.rings.length, 1);
  assert.equal(result.rings[0].length, 4);
  assert.equal(result.consolidatedCells, 9999);
  assert.equal(area(result.rings), 10000);
  assert.equal(result.unresolved, false);
});

test("duplicate cells, invalid geometry, and work-budget exhaustion preserve input", () => {
  for (const rings of [
    [rect(0, 0), rect(0, 0)],
    [
      rect(0, 0),
      [
        [0, 0],
        [1e308, 0],
        [0, 1e308],
      ],
    ],
    [
      rect(0, 0),
      [
        [0, 0],
        [1, NaN],
        [0, 1],
      ],
    ],
    Array.from({ length: 20001 }, () => rect(0, 0)),
  ]) {
    const result = consolidateAreaDeductions(rings);
    assert.equal(result.rings, rings);
    assert.equal(result.unresolved, true);
    assert.equal(result.consolidatedCells, 0);
  }
});
