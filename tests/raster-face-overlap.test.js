require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { rasterFaceOverlap } = require("../lib/drawings/raster-face-overlap");
const face = (a, b) => {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { a, b, u: [(b[0] - a[0]) / length, (b[1] - a[1]) / length], length };
};
test("uniform source depth requires intersecting per-position intervals on only the measured overlap", () => {
  const a = face([0, 0], [100, 0]),
    b = face([-100, 19], [100, 21]);
  const result = rasterFaceOverlap(a, b, 0.5);
  assert.deepEqual(result, {
    lo: 0,
    hi: 100,
    depths: [20, 21],
    depth: 20.5,
    depthInterval: [20.5, 20.5],
  });
  assert.equal(rasterFaceOverlap(a, b, 0.49), null);
  assert.deepEqual(rasterFaceOverlap(a, face(b.b, b.a), 0.5), result);
  assert.equal(rasterFaceOverlap(a, face([150, 20], [250, 20]), 1), null);
  assert.equal(rasterFaceOverlap(a, face([0, -1], [100, 1]), 100), null);
  assert.equal(rasterFaceOverlap(a, b, NaN), null);
  assert.equal(rasterFaceOverlap(a, { ...b, a: [NaN, 19] }, 0.5), null);
});
test("rotation and translation retain the same measured overlap and uncertainty interval", () => {
  const a = face([0, 0], [100, 0]),
    b = face([-100, 19], [100, 21]),
    ref = rasterFaceOverlap(a, b, 0.6);
  for (const angle of [0.37, -0.8, Math.PI / 2]) {
    const rotate = ([x, y]) => [
      300 + x * Math.cos(angle) - y * Math.sin(angle),
      -150 + x * Math.sin(angle) + y * Math.cos(angle),
    ];
    const r = rasterFaceOverlap(
      face(rotate(a.a), rotate(a.b)),
      face(rotate(b.a), rotate(b.b)),
      0.6,
    );
    for (const k of ["lo", "hi", "depth"])
      assert.ok(Math.abs(r[k] - ref[k]) < 1e-9);
    for (const k of ["depths", "depthInterval"])
      assert.ok(r[k].every((v, i) => Math.abs(v - ref[k][i]) < 1e-9));
  }
});
